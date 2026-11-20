import { logger } from "../core/log.js";

const log = logger("payment");

export interface TransferOrder {
  fromIban: string;
  toIban: string;
  toName: string;
  amountCents: number;
  reference: string;
  endToEndId: string;
}

export type TransferResult =
  | { status: "submitted"; bankReference?: string; needsBankApproval: boolean }
  | { status: "dryrun" }
  | { status: "failed"; error: string };

export interface PaymentProvider {
  readonly name: string;
  transfer(order: TransferOrder): Promise<TransferResult>;
}

/** Testmodus: führt keine Überweisung aus, protokolliert nur. */
export class DryRunProvider implements PaymentProvider {
  readonly name = "dryrun";
  async transfer(order: TransferOrder): Promise<TransferResult> {
    log.info(`TESTMODUS – würde überweisen: ${order.amountCents / 100} EUR an ${order.toName} (${order.toIban})`);
    return { status: "dryrun" };
  }
}

/**
 * FinTS-Anbindung (Sparkasse Duisburg, Deutsche Bank, DKB).
 * Wird umgesetzt, sobald die Produktregistrierungsnummer da ist –
 * ohne sie lehnen die Banken die Verbindung ab.
 */
export class FinTSProvider implements PaymentProvider {
  readonly name = "fints";
  async transfer(): Promise<TransferResult> {
    return { status: "failed", error: "FinTS ist noch nicht eingerichtet (Produktregistrierung ausstehend)." };
  }
}
