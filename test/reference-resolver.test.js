import test from "node:test";
import assert from "node:assert/strict";
import { equipmentSlotFromText, selectWikiCandidate, selectWikiImageFile, shouldRefreshReference, wikiSourceMatchesProduct } from "../src/reference-resolver.js";

test("normalizes armor slots from blueprint identifiers", () => {
  assert.equal(equipmentSlotFromText("BP_CRAFT_qrt_specialist_heavy_arms_01_01_15"), "ARMS");
  assert.equal(equipmentSlotFromText("BP_CRAFT_qrt_specialist_heavy_helmet_01"), "HELMET");
  assert.equal(equipmentSlotFromText("BP_CRAFT_qrt_specialist_heavy_core_01"), "CORE");
  assert.equal(equipmentSlotFromText("BP_CRAFT_qrt_specialist_heavy_legs_01"), "LEGS");
});

test("rejects a helmet candidate for the Antium arms blueprint", () => {
  const result = selectWikiCandidate([
    { title: "Antium Armor Helmet Sand", thumbnail: { source: "helmet.jpg" } },
    { title: "Antium Armor Arms Sand", thumbnail: { source: "arms.jpg" } }
  ], { productName: "Antium Arms Sand", blueprintTag: "BP_CRAFT_qrt_specialist_heavy_arms_01_01_15" });
  assert.equal(result.title, "Antium Armor Arms Sand");
  assert.equal(result.thumbnail.source, "arms.jpg");
  assert.notEqual(result.title, "Antium Armor Helmet Sand");
});

test("fails closed when no candidate has the expected slot", () => {
  assert.equal(selectWikiCandidate([{ title: "Antium Armor Helmet Sand" }], {
    productName: "Antium Arms Sand", blueprintTag: "BP_CRAFT_qrt_specialist_heavy_arms_01_01_15"
  }), null);
});

test("keeps an exact Wiki page without a pageimages thumbnail", () => {
  const result = selectWikiCandidate([{ title: "ADP Arms Red" }], {
    productName: "ADP Arms Red", blueprintTag: "BP_CRAFT_cds_legacy_armor_heavy_arms_01_01_02"
  });
  assert.equal(result.title, "ADP Arms Red");
});

test("uses a matching base image but rejects a wrong armor color or slot", () => {
  const badger = selectWikiImageFile([
    { title: "File:CF-117 Bulldog Repeater cutout stripe BG SCT logo.png" },
    { title: "File:CF-227 Badger Repeater cutout stripe BG SCT logo.png" }
  ], { productName: "CF-227 Badger Hazard-Zone Repeater", blueprintTag: "BP_CRAFT_KLWE_LaserRepeater_S2_mr01" });
  assert.equal(badger.title, "File:CF-227 Badger Repeater cutout stripe BG SCT logo.png");
  const adp = selectWikiImageFile([
    { title: "File:ADP Core Red - In-game SCT logo.jpg" },
    { title: "File:Adp arms black 02.png" }
  ], { productName: "ADP Arms Red", blueprintTag: "BP_CRAFT_cds_legacy_armor_heavy_arms_01_01_02" });
  assert.equal(adp, null);
});

test("rejects incomplete Wiki matches for named blueprint variants", () => {
  const result = selectWikiCandidate([
    { title: "Mirage", thumbnail: { source: "shield.jpg" } },
    { title: "Atzkav \"Mirage\" Sniper Rifle", thumbnail: { source: "rifle.jpg" } }
  ], { productName: "Atzkav Mirage Sniper Rifle", blueprintTag: "BP_CRAFT_lbco_sniper_energy_01_chromic01" });
  assert.equal(result.thumbnail.source, "rifle.jpg");
  assert.equal(wikiSourceMatchesProduct("https://starcitizen.tools/Mirage", "Atzkav Mirage Sniper Rifle"), false);
  assert.equal(wikiSourceMatchesProduct("https://starcitizen.tools/Atzkav_%22Mirage%22_Sniper_Rifle", "Atzkav Mirage Sniper Rifle"), true);
});

test("force refresh bypasses a fresh reference cache", () => {
  const fresh = new Date("2026-08-20T00:00:00Z");
  assert.equal(shouldRefreshReference({ checkedAt: fresh, now: new Date("2026-08-26T00:00:00Z").getTime() }), false);
  assert.equal(shouldRefreshReference({ checkedAt: fresh, force: true, now: new Date("2026-08-26T00:00:00Z").getTime() }), true);
  assert.equal(shouldRefreshReference({ checkedAt: new Date("2026-07-01T00:00:00Z"), now: new Date("2026-08-26T00:00:00Z").getTime() }), true);
});
