import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidPhoneNumber } from "libphonenumber-js/max";
import {
  dummyPhonesForCountry,
  resolvePhoneCountry,
  valuesToType,
} from "../src/crawler/phone_for_country.js";

describe("phone country resolution", () => {
  it("resolves ISO, calling code, and country name independently of location", () => {
    assert.equal(resolvePhoneCountry({ iso: "in" }), "IN");
    assert.equal(resolvePhoneCountry({ callingCode: "91" }), "IN");
    assert.equal(resolvePhoneCountry({ countryName: "India" }), "IN");
    assert.equal(resolvePhoneCountry({ extraText: "India: +91" }), "IN");
    assert.equal(resolvePhoneCountry({ callingCode: "44", countryName: "United Kingdom" }), "GB");
    assert.equal(resolvePhoneCountry({ iso: "US" }), "US");
    assert.equal(resolvePhoneCountry({ callingCode: "1", countryName: "Canada" }), "CA");
  });

  it("does not fall back to a hardcoded country when hints are empty", () => {
    assert.equal(resolvePhoneCountry({}), null);
  });
});

describe("country-specific dummy phones", () => {
  for (const country of ["IN", "US", "GB", "DE", "AU", "BR", "AE", "NG"] as const) {
    it(`generates libphonenumber-valid numbers for ${country}`, () => {
      const phones = dummyPhonesForCountry(country, 4);
      assert.ok(phones.length >= 1, `expected at least one dummy number for ${country}`);
      for (const phone of phones) {
        assert.equal(phone.country, country);
        assert.equal(isValidPhoneNumber(phone.e164), true);
        assert.equal(isValidPhoneNumber(phone.national, country), true);
        assert.ok(valuesToType(phone).includes(phone.national));
      }
    });
  }

  it("India numbers use +91 and are not US 10-digit NANP values", () => {
    const [india] = dummyPhonesForCountry("IN", 1);
    assert.ok(india);
    assert.equal(india.callingCode, "91");
    assert.notEqual(india.national, "2024567890");
    assert.match(india.national, /^[6-9]\d{9}$/);
  });
});
