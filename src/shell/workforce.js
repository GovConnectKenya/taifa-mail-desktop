'use strict';
const status = document.querySelector('#status');
const submit = document.querySelector('#submit');
const rows = document.querySelector('#mailboxes');
function render(state) {
  status.textContent = state.message;
  submit.disabled = ['browser', 'working', 'selection'].includes(state.phase);
  rows.replaceChildren();
  for (const row of state.mailboxes || []) {
    const button = document.createElement('button');
    button.textContent = row.address;
    button.addEventListener('click', async () => { button.disabled = true; await window.workforce.select(row.id); });
    rows.append(button);
  }
}
window.workforce.subscribe(render);
window.workforce.state().then(render);
document.querySelector('#start').addEventListener('submit', async event => {
  event.preventDefault();
  submit.disabled = true;
  await window.workforce.start(document.querySelector('#org').value.trim(), document.querySelector('#recent').checked);
});
document.querySelector('#cancel').addEventListener('click', () => window.workforce.cancel());
document.querySelector('#logout').addEventListener('click', () => window.workforce.logout());
