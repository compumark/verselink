import test from "node:test";
import assert from "node:assert/strict";
import { calculateInventorySummary, calculateSurplus, calculateTargetStatus, calculateLocationSummary, filterInventory, catalogSearchUrl } from "../public/js/personalinventory-core.js";

const items = [
  { item_id: "p4", name: "P4-AR Rifle", manufacturer: "Behring", category: "Weapons", subcategory: "Assault Rifle", location_id: "lorville", quantity: 3 },
  { item_id: "p4", name: "P4-AR Rifle", manufacturer: "Behring", category: "Weapons", subcategory: "Assault Rifle", location_id: "area18", quantity: 1 },
  { item_id: "fs9", name: "FS-9", manufacturer: "Behring", category: "Weapons", subcategory: "LMG", location_id: "lorville", quantity: 2 }
];

test("personal inventory summary counts unique items, quantity and locations", () => {
  assert.deepEqual(calculateInventorySummary(items), { uniqueItems: 2, totalItems: 6, locations: 2 });
});

test("personal inventory filtering is case-insensitive and combines filters", () => {
  assert.equal(filterInventory(items, { query: "BEHRING", location: "area18" }).length, 1);
  assert.equal(filterInventory(items, { category: "Weapons", location: "lorville" }).length, 2);
});

test("catalog search uses the backend search parameter and supports an empty query", () => {
  assert.equal(catalogSearchUrl("p4"), "/api/personalinventory/catalog?search=p4");
  assert.equal(catalogSearchUrl(""), "/api/personalinventory/catalog?search=");
  assert.equal(catalogSearchUrl("Behring Weapons"), "/api/personalinventory/catalog?search=Behring%20Weapons");
});

test("surplus is never negative and location summary aggregates quantities", () => {
  assert.equal(calculateSurplus({ quantity: 7, target_quantity: 2 }), 5);
  assert.equal(calculateSurplus({ quantity: 1, target_quantity: 3 }), 0);
  assert.deepEqual(calculateLocationSummary([
    { location_id: "lorville", location_name: "Lorville", quantity: 5 },
    { location_id: "lorville", location_name: "Lorville", quantity: 2 },
    { location_id: "area18", location_name: "Area18", quantity: 10 }
  ]), [{ location_id: "area18", name: "Area18", quantity: 10 }, { location_id: "lorville", name: "Lorville", quantity: 7 }]);
});

test("target status distinguishes overstock, missing, reached and unset", () => {
  assert.deepEqual(calculateTargetStatus({ quantity: 7, target_quantity: 2 }), { type: "OVERSTOCK", quantity: 5 });
  assert.deepEqual(calculateTargetStatus({ quantity: 1, target_quantity: 7 }), { type: "MISSING", quantity: 6 });
  assert.deepEqual(calculateTargetStatus({ quantity: 7, target_quantity: 7 }), { type: "TARGET_REACHED", quantity: 0 });
  assert.deepEqual(calculateTargetStatus({ quantity: 5, target_quantity: 0 }), { type: "OVERSTOCK", quantity: 5 });
  assert.equal(calculateTargetStatus({ quantity: 5, target_quantity: null }), null);
});

test("quality-of-life filters combine with existing filters", () => {
  const qolItems = items.map((item, index) => ({ ...item, favorite: index === 0, trade_status: index === 1 ? "FOR_TRADE" : "NOT_FOR_TRADE", owner_note: index === 2 ? "Special" : null, target_quantity: index === 0 ? 1 : null }));
  assert.equal(filterInventory(qolItems, { filter: "FAVORITES" }).length, 1);
  assert.equal(filterInventory(qolItems, { filter: "FOR_TRADE", location: "area18" }).length, 1);
  assert.equal(filterInventory(qolItems, { filter: "HAS_NOTE" }).length, 1);
  assert.equal(filterInventory([{ ...qolItems[0], quantity: 3 }], { filter: "SURPLUS" }).length, 1);
});
