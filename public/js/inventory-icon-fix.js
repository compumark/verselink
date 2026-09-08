const blueprintIconUrl = "/assets/icons/blueprint-schematic.svg?v=2";
const materialIconUrl = "/assets/icons/material-crate.svg?v=2";
const inventoryIconUrl = "/assets/icons/inventory-cube.svg?v=1";

const applyBlueprintIcon = () => {
  document.querySelectorAll(
    '.nav-inventory-menu button:first-child .nav-icon, .app[data-app="inventory"] .app-icon'
  ).forEach((icon) => {
    icon.style.setProperty("--icon", `url("${blueprintIconUrl}")`);
    icon.style.webkitMaskImage = `url("${blueprintIconUrl}")`;
    icon.style.maskImage = `url("${blueprintIconUrl}")`;
  });
  document.querySelectorAll('.nav button[data-view="inventory"] .nav-icon').forEach((icon) => {
    icon.style.setProperty("--icon", `url("${inventoryIconUrl}")`);
    icon.style.mask = `url("${inventoryIconUrl}") center / contain no-repeat`;
    icon.style.webkitMask = `url("${inventoryIconUrl}") center / contain no-repeat`;
    icon.style.webkitMaskImage = `url("${inventoryIconUrl}")`;
    icon.style.maskImage = `url("${inventoryIconUrl}")`;
  });
};

applyBlueprintIcon();
new MutationObserver(applyBlueprintIcon).observe(document.body, { childList: true, subtree: true });
