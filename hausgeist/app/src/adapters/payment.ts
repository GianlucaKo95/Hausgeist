import { createRequire } from "node:module";
import type * as Fints from "fints-lib";
import type { BankKey, Config } from "../core/config.js";
import { logger } from "../core/log.js";

const log = logger("payment");
const require = createRequire(import.meta.url);
const fints = require("fints-lib") as typeof Fints;

export interface TransferOrder {
  bank: BankKey;
  fromIban: string;
  debtorName: string;
  toIban: string;
  toName: string;
  amountCents: number;
  reference: string;
  endToEndId: string;
}

export interface TransferHooks {
  /** Die Bank wartet auf die Freigabe in ihrer App (pushTAN, BestSign, DKB-App). */
  onBankApproval?: (text: string) => Promise<void>;
}

export type TransferResult =
  | { status: "submitted"; bankReference?: string; needsBankApproval: boolean }
  | { status: "dryrun" }
  | { status: "failed"; error: string };

export interface PaymentProvider {
  readonly name: string;
  transfer(order: TransferOrder, hooks?: TransferHooks): Promise<TransferResult>;
}

/** Testmodus: führt keine Überweisung aus, protokolliert nur. */
export class DryRunProvider implements PaymentProvider {
  readonly name = "dryrun";
  async transfer(order: TransferOrder): Promise<TransferResult> {
    log.info(`TESTMODUS – würde überweisen: ${order.amountCents / 100} EUR an ${order.toName} (${order.toIban})`);
    return { status: "dryrun" };
  }
}

/** FinTS-Server der drei Banken (Quelle: Institutsverzeichnis der Deutschen Kreditwirtschaft). */
export const BANK_INFO: Record<BankKey, { name: string; url: string }> = {
  sparkasse_duisburg: { name: "Sparkasse Duisburg", url: "https://banking-rl4.s-fints-pt-rl.de/fints30" },
  deutsche_bank: { name: "Deutsche Bank", url: "https://fints.deutsche-bank.de/" },
  dkb: { name: "DKB", url: "https://fints.dkb.de/fints" },
};

/** Bankleitzahl aus einer deutschen IBAN (Stellen 5–12). */
export function blzFromIban(iban: string): string {
  const clean = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^DE\d{20}$/.test(clean)) throw new Error("Nur deutsche IBANs werden per FinTS unterstützt.");
  return clean.slice(4, 12);
}

type TanMethodLike = { name?: string; securityFunction?: string; decoupledMaxStatusRequests?: number };

/** App-Freigabe vor allen anderen Verfahren, damit niemand eine TAN abtippen muss. */
export function preferDecoupled<T extends TanMethodLike>(methods: T[]): T[] {
  const score = (m: T) =>
    m.decoupledMaxStatusRequests !== undefined ? 0 : /push|app|bestsign|decoupled|secure ?go/i.test(m.name ?? "") ? 1 : 2;
  return methods.sort((a, b) => score(a) - score(b));
}

export interface BankTestResult {
  accounts: { iban: string; name?: string }[];
  tanMethods: string[];
}

/** Übersetzt Bankfehler in verständliche Sätze. */
function explain(e: unknown): string {
  if (e instanceof fints.PinError) return "Anmeldename oder PIN falsch.";
  if (e instanceof fints.AuthenticationError) return "Die Bank hat die Anmeldung abgelehnt (Produkt-ID oder Zugang prüfen).";
  if (e instanceof fints.DecoupledTanError) return "Die Freigabe in der Banking-App kam nicht rechtzeitig oder wurde abgelehnt.";
  const msg = e instanceof Error ? e.message : String(e);
  if (/9078|9800|produkt|product/i.test(msg)) return `Die Bank lehnt die Produkt-ID ab: ${msg}`;
  return msg;
}

const NO_DECOUPLED =
  "Die Bank verlangt eine TAN zum Abtippen. Bitte stell im Online-Banking die App-Freigabe (S-pushTAN, BestSign oder DKB-App) als TAN-Verfahren ein.";

/**
 * Überweisungen per FinTS 3.0 (Sparkasse Duisburg, Deutsche Bank, DKB).
 * Freigabe läuft immer über die Banking-App der Bank (Decoupled TAN) –
 * der Hausgeist sieht und speichert niemals eine TAN.
 */
export class FinTSProvider implements PaymentProvider {
  readonly name = "fints";

  constructor(private readonly config: Config) {}

  private client(bank: BankKey, blz: string, override?: { login: string; pin: string; url?: string }) {
    const productId = this.config.fints_product_id.replace(/\s+/g, "");
    if (!productId) throw new Error("Die FinTS-Produkt-ID fehlt. Bitte in der App unter Verwaltung → Konten eintragen.");
    if (productId.length !== 25) throw new Error(`Die FinTS-Registrierungsnummer muss genau 25 Zeichen haben (eingetragen: ${productId.length}).`);
    const login = override ?? this.config.bank_logins[bank];
    if (!login) throw new Error(`Für ${BANK_INFO[bank].name} ist noch kein Bankzugang hinterlegt.`);

    const state = { tanMethods: [] as string[] };
    // Nach jedem Dialogaufbau die App-Freigabe nach vorn sortieren.
    class Client extends fints.PinTanClient {
      override createDialog(cfg?: Fints.DialogConfig) {
        const d = super.createDialog(cfg);
        const patched = d as unknown as Record<"sync" | "init", () => Promise<unknown>>;
        for (const fn of ["sync", "init"] as const) {
          const orig = patched[fn].bind(d);
          patched[fn] = async () => {
            const r = await orig();
            preferDecoupled(d.tanMethods as TanMethodLike[]);
            state.tanMethods = d.tanMethods.map((m: TanMethodLike) => m.name ?? m.securityFunction ?? "?");
            return r;
          };
        }
        return d;
      }
    }
    const client = new Client({
      url: login.url || BANK_INFO[bank].url,
      blz,
      name: login.login,
      pin: login.pin,
      productId,
      timeout: 60_000,
      // bis zu ~5 Minuten auf die Freigabe in der Banking-App warten
      decoupledTanConfig: { maxStatusRequests: 100, waitBeforeFirstStatusRequest: 3000, waitBetweenStatusRequests: 3000 },
    });
    return { client, state };
  }

  /** Führt op aus; verlangt die Bank eine App-Freigabe, wird darauf gewartet. */
  private async withApproval<T>(
    client: Fints.PinTanClient,
    op: () => Promise<T>,
    hooks?: TransferHooks,
  ): Promise<{ value: T } | { confirmed: true }> {
    try {
      return { value: await op() };
    } catch (e) {
      if (!(e instanceof fints.TanRequiredError)) throw e;
      if (!e.isDecoupledTan()) {
        await e.dialog?.end().catch(() => undefined);
        throw new Error(NO_DECOUPLED);
      }
      await hooks?.onBankApproval?.(e.challengeText || "Bitte in der Banking-App freigeben.");
      await client.handleDecoupledTanChallenge(e);
      await e.dialog?.end().catch(() => undefined);
      return { confirmed: true };
    }
  }

  private async accounts(client: Fints.PinTanClient, hooks?: TransferHooks): Promise<Fints.SEPAAccount[]> {
    const first = await this.withApproval(client, () => client.accounts(), hooks);
    if ("value" in first) return first.value;
    // Anmeldung war freigabepflichtig – jetzt erneut abrufen.
    const second = await this.withApproval(client, () => client.accounts(), hooks);
    if ("value" in second) return second.value;
    throw new Error("Die Bank hat nach der Freigabe keine Konten geliefert.");
  }

  /**
   * Prüft ohne Rückfrage, ob die Bank die Registrierungsnummer schon kennt.
   * Wartet NIE auf eine App-Freigabe: verlangt die Bank eine, ist die Nummer ja angenommen.
   */
  async probe(bank: BankKey, blz: string): Promise<"active" | "pending" | "pin" | "error"> {
    try {
      const { client } = this.client(bank, blz);
      await client.accounts();
      return "active";
    } catch (e) {
      if (e instanceof fints.TanRequiredError) {
        await e.dialog?.end().catch(() => undefined);
        return "active";
      }
      if (e instanceof fints.PinError) return "pin";
      const msg = e instanceof Error ? e.message : String(e);
      if (/9078|nicht registriert/i.test(msg)) return "pending";
      log.warn(`FinTS-Prüfung ${BANK_INFO[bank].name}: ${msg}`);
      return "error";
    }
  }

  /** Verbindungstest aus der App: Konten und TAN-Verfahren anzeigen. */
  async test(bank: BankKey, blz: string, login?: { login: string; pin: string; url?: string }, hooks?: TransferHooks): Promise<BankTestResult> {
    try {
      const { client, state } = this.client(bank, blz, login);
      const list = await this.accounts(client, hooks);
      return {
        accounts: list.map((a) => ({ iban: a.iban, name: (a as { accountName?: string }).accountName })),
        tanMethods: state.tanMethods,
      };
    } catch (e) {
      throw new Error(explain(e));
    }
  }

  async transfer(order: TransferOrder, hooks?: TransferHooks): Promise<TransferResult> {
    try {
      const { client } = this.client(order.bank, blzFromIban(order.fromIban));
      const list = await this.accounts(client, hooks);
      const account = list.find((a) => a.iban.replace(/\s+/g, "") === order.fromIban.replace(/\s+/g, ""));
      if (!account) return { status: "failed", error: `Das Konto ${order.fromIban} ist in diesem Bankzugang nicht freigeschaltet.` };

      const request: Fints.CreditTransferRequest = {
        debtorName: order.debtorName,
        creditor: { name: order.toName.slice(0, 70), iban: order.toIban.replace(/\s+/g, "") },
        amount: order.amountCents / 100,
        currency: "EUR",
        endToEndId: order.endToEndId,
        remittanceInformation: order.reference.slice(0, 140),
      };
      const result = await this.withApproval(client, () => client.creditTransfer(account, request), hooks);
      if ("value" in result) {
        log.info(`Überweisung übermittelt: ${order.amountCents / 100} EUR an ${order.toName}`);
        return { status: "submitted", bankReference: result.value.taskId ?? order.endToEndId, needsBankApproval: false };
      }
      log.info(`Überweisung nach App-Freigabe übermittelt: ${order.amountCents / 100} EUR an ${order.toName}`);
      return { status: "submitted", bankReference: order.endToEndId, needsBankApproval: false };
    } catch (e) {
      const error = explain(e);
      log.error(`Überweisung fehlgeschlagen: ${error}`);
      return { status: "failed", error };
    }
  }
}

/** Wählt bei jeder Zahlung live den Modus aus den Einstellungen. */
export class SwitchingProvider implements PaymentProvider {
  constructor(
    private readonly config: Config,
    private readonly dryrun: DryRunProvider,
    readonly fints: FinTSProvider,
  ) {}
  get name(): string {
    return this.config.payment_mode;
  }
  transfer(order: TransferOrder, hooks?: TransferHooks): Promise<TransferResult> {
    return (this.config.payment_mode === "fints" ? this.fints : this.dryrun).transfer(order, hooks);
  }
}
