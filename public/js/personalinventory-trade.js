import { updateTradeSettings } from './personalinventory-core.js';

const message = document.querySelector('#message');
const showError = error => { message.textContent = error.message || 'Unable to update trade settings.'; message.hidden = false; };
let updateInFlight = false;
const timers = new Map();

const saveTrade = async control => {
  const id = control.dataset.tradeStatus || control.dataset.tradeQuantity;
  if (!id || updateInFlight) return;
  const status = document.querySelector(`[data-trade-status="${id}"]`);
  const tradeQuantity = document.querySelector(`[data-trade-quantity="${id}"]`);
  const card = control.closest('.card');
  const quantity = Number(card.querySelector('[data-quantity]').value);
  try {
    updateInFlight = true;
    await updateTradeSettings(id, quantity, status.value, status.value === 'NOT_FOR_TRADE' ? 0 : Number(tradeQuantity.value));
    window.location.reload();
  } catch (error) { showError(error); } finally { updateInFlight = false; }
};

const scheduleTradeSave = control => {
  const id = control.dataset.tradeStatus || control.dataset.tradeQuantity;
  if (!id) return;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => saveTrade(control), 350));
};

document.querySelector('#inventory').addEventListener('input', event => {
  if (event.target.matches('[data-trade-quantity]')) scheduleTradeSave(event.target);
});
document.querySelector('#inventory').addEventListener('change', event => {
  const control = event.target;
  if (control.matches('[data-trade-status]')) { scheduleTradeSave(control); return; }
  if (control.matches('[data-trade-quantity]')) scheduleTradeSave(control);
});
