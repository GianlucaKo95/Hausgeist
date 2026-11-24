import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEnergy } from "../dist/core/energy-detect.js";

const st = (id, name, state, unit, device_class) => ({ entity_id: id, state: String(state), attributes: { friendly_name: name, unit_of_measurement: unit, device_class } });

const states = [
  st("sensor.inverter_input_power", "Wechselrichter Eingangsleistung", 2350, "W", "power"),
  st("sensor.solar_forecast_power", "PV-Prognose Leistung", 3000, "W", "power"),
  st("sensor.pv_energy_today", "PV Ertrag heute", 12.3, "kWh", "energy"),
  st("sensor.battery_charge_discharge_power", "Speicher Lade-/Entladeleistung", -450, "W", "power"),
  st("sensor.battery_state_of_capacity", "Speicher SOC", 76, "%", "battery"),
  st("sensor.iphone_battery_level", "iPhone Battery Level", 54, "%", "battery"),
  st("sensor.power_meter_active_power", "Netz Wirkleistung", -1200, "W", "power"),
  st("sensor.power_meter_phase_a_active_power", "Netz Phase A", -400, "W", "power"),
  st("sensor.house_consumption_power", "Hausverbrauch", 700, "W", "power"),
];

test("Energie-Sensoren nach Namen und Einheit", () => {
  const r = detectEnergy(states);
  assert.equal(r.pick.pv_power, "sensor.inverter_input_power");
  assert.equal(r.pick.battery_power, "sensor.battery_charge_discharge_power");
  assert.equal(r.pick.battery_soc, "sensor.battery_state_of_capacity");
  assert.equal(r.pick.grid_power, "sensor.power_meter_active_power");
  assert.equal(r.pick.house_power, "sensor.house_consumption_power");
  assert.equal(r.fromDashboard, false);
});

test("Energie-Dashboard gibt den Ausschlag (gleiches Gerät)", () => {
  const extra = [...states, st("sensor.dach_west_leistung", "Dach West Leistung", 900, "W", "power")];
  const registry = [
    { entity_id: "sensor.dach_west_leistung", device_id: "dev-west" },
    { entity_id: "sensor.dach_west_ertrag", device_id: "dev-west" },
    { entity_id: "sensor.inverter_input_power", device_id: "dev-inv" },
  ];
  const prefs = { energy_sources: [{ type: "solar", stat_energy_from: "sensor.dach_west_ertrag" }] };
  const r = detectEnergy(extra, registry, prefs);
  assert.equal(r.pick.pv_power, "sensor.dach_west_leistung");
  assert.equal(r.fromDashboard, true);
});

test("Sungrow-Integration (Modbus): typische Namen", () => {
  const sungrow = [
    st("sensor.total_dc_power", "Total DC power", 4120, "W", "power"),
    st("sensor.daily_pv_generation", "Daily PV generation", 18.2, "kWh", "energy"),
    st("sensor.battery_level", "Battery level", 63, "%", "battery"),
    st("sensor.battery_charging_power", "Battery charging power", 1500, "W", "power"),
    st("sensor.battery_power", "Battery power", 1500, "W", "power"),
    st("sensor.meter_active_power", "Meter active power", -900, "W", "power"),
    st("sensor.load_power", "Load power", 1700, "W", "power"),
    st("sensor.export_power", "Export power", 900, "W", "power"),
  ];
  const r = detectEnergy(sungrow);
  assert.equal(r.pick.pv_power, "sensor.total_dc_power");
  assert.equal(r.pick.battery_soc, "sensor.battery_level");
  assert.ok(["sensor.battery_power", "sensor.battery_charging_power"].includes(r.pick.battery_power));
  assert.equal(r.pick.grid_power, "sensor.meter_active_power");
  assert.equal(r.pick.house_power, "sensor.load_power");
});
