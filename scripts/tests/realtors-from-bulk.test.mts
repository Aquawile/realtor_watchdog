// Tests for building `realtors` rows from the DRE bulk file and fingerprinting them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPECTED_COLUMNS, type DreRow } from "../lib/dre-bulk.mts";
import { buildScope, bulkDate, fingerprint } from "../lib/realtors-from-bulk.mts";

const row = (o: Partial<DreRow>): DreRow =>
  ({ ...Object.fromEntries(EXPECTED_COLUMNS.map((c) => [c, ""])), restricted_flag: "N", county_name: "ORANGE", ...o }) as DreRow;

const FILE: DreRow[] = [
  row({ lic_number: "01234567", lic_type: "Salesperson", lastname_primary: "Doe", firstname_secondary: "Jane Q", lic_status: "Licensed",
    lic_effective_date: "20250516", lic_expiration_date: "20290515", original_date_of_license: "19690516",
    related_lic_number: "00616212", related_lastname_primary: "Coldwell Banker Residential", related_firstname_secondary: "Brokerage Company",
    related_lic_type: "Corporation", city: "IRVINE", address_1: "123 MAIN ST" }),
  row({ lic_number: "00007012", lic_type: "Broker", lastname_primary: "Roe", firstname_secondary: "Pat", lic_status: "Licensed", restricted_flag: "Y" }),
  row({ lic_number: "00007012", lic_type: "Officer", related_lic_number: "02000002", related_lastname_primary: "Roe Realty", related_firstname_secondary: "Inc", related_lic_type: "Corporation" }),
  row({ lic_number: "00007012", lic_type: "Officer", related_lic_number: "01000001", related_lastname_primary: "Pat Roe Homes Inc", related_lic_type: "Corporation" }),
  row({ lic_number: "07777777", lic_type: "Salesperson", lastname_primary: "Far", county_name: "LOS ANGELES" }),
  row({ lic_number: "08888888", lic_type: "Corporation", lastname_primary: "Some Corp" }),
];

test("keeps only Orange County salespersons and brokers", () => {
  assert.deepEqual([...buildScope(FILE).keys()].sort(), ["00007012", "01234567"]);
});

test("maps fields: dates, restricted flag, wrapped corporation broker name, officer roles sorted; no street address", () => {
  const s = buildScope(FILE);
  const sp = s.get("01234567")!;
  assert.equal(sp.license_type, "salesperson");
  assert.equal(sp.original_license_date, "1969-05-16");
  assert.equal(sp.employing_broker_name, "Coldwell Banker Residential Brokerage Company");
  assert.equal(sp.city, "IRVINE");
  assert.ok(!JSON.stringify(sp).includes("MAIN ST"), "street address is never stored");
  const br = s.get("00007012")!;
  assert.equal(br.restricted_license, true);
  assert.deepEqual(br.officer_of, [
    { license_number: "01000001", name: "Pat Roe Homes Inc" },
    { license_number: "02000002", name: "Roe Realty Inc" },
  ]);
});

test("fingerprint is stable for identical data and changes when DRE data changes", () => {
  const a = buildScope(FILE).get("01234567")!;
  const b = buildScope(FILE).get("01234567")!;
  assert.equal(fingerprint(a), fingerprint(b));
  assert.match(fingerprint(a), /^[0-9a-f]{64}$/);
  assert.notEqual(fingerprint(a), fingerprint({ ...a, employing_broker_name: "Compass" }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, license_status: "Licensed NBA" }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, restricted_license: true }));
});

test("rejects malformed dates and duplicate individual licenses", () => {
  assert.throws(() => bulkDate("2025-05-16"), /unexpected DRE date/);
  assert.equal(bulkDate(""), null);
  assert.throws(() => buildScope([...FILE, FILE[0]]), /duplicate individual license 01234567/);
});
