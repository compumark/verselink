const formatScuText = value => value.replace(/(\d+(?:\.\d+)?)\s+SCU\b/g, (_, number) => `${Number(number).toFixed(2)} SCU`);
const formatTextNodes = root => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => { const next = formatScuText(node.nodeValue); if (next !== node.nodeValue) node.nodeValue = next; });
};
const observe = () => {
  const content = document.querySelector('#content');
  if (!content) return;
  const apply = () => { if (location.hash === '#material') formatTextNodes(content); };
  new MutationObserver(apply).observe(content, { childList: true, subtree: true, characterData: true });
  apply();
};
window.addEventListener('load', observe);
