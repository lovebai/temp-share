const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() {
    this.style = {};
    this.children = [];
    this.events = {};
    this.nodes = new Map();
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value), remove: value => classes.delete(value),
      contains: value => classes.has(value), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value),
    };
  }
  addEventListener(name, handler) { this.events[name] = handler; }
  click() { if (!this.disabled) return this.events.click?.({ target: this }); }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  select() { this.selected = true; }
  remove() {}
}

test('page sharing, manual copy, batch selection, deletion and expired state', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const elements = new Map(Array.from(html.matchAll(/id="([^"]+)"/g), match => [match[1], new Element()]));
  const get = id => { assert.ok(elements.has(id), `Missing page element: ${id}`); return elements.get(id); };
  const document = {
    getElementById: get, querySelector: selector => get(selector.slice(1)), querySelectorAll: () => [],
    createElement: () => new Element(), addEventListener() {}, body: new Element(), activeElement: null,
  };
  const requests = [];
  const location = { origin: 'http://localhost', search: '?code=123456', assign() {} };
  const context = vm.createContext({
    document, window: { location }, location, navigator: {}, URLSearchParams, Date,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    fetch: async (url, opts) => {
      requests.push({ url, opts });
      return { ok: true, json: async () => url === '/api/config' ? { maxSize: 100, maxFiles: 20 } : { code: '654321', expiresIn: 300, deleted: true } };
    },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1] + '\nglobalThis.ui = { S, setFiles, showResult, startResultCountdown };', context);
  await new Promise(resolve => setImmediate(resolve));
  const { ui } = context;
  assert.equal(ui.S.mode, 'retrieve');
  assert.equal(get('retrieve-input').value, '123456');
  assert.equal(ui.S.maxSize, 100);
  ui.setFiles([{ name: '<img src=x onerror=alert(1)>', size: 10 }, { name: 'second.txt', size: 20 }]);
  assert.equal(ui.S.files.length, 2);
  assert.equal(get('file-preview').children[0].querySelector('.fp-name').textContent, '<img src=x onerror=alert(1)>');
  const first = { id: 'one', originalName: 'first.txt', extractCode: '111111', url: '/api/download/one', size: 10, expiresAt: Date.now() + 60000, deleteToken: 'private-token' };
  const second = { ...first, id: 'two', originalName: 'second.txt' };
  ui.S.batch = [first, second];
  ui.S.result = first;
  ui.showResult('upload');
  assert.equal(get('result-extract-block').style.display, 'block');
  assert.equal(get('btn-copy-share').style.display, 'inline-block');
  assert.equal(get('btn-download').style.display, 'none');
  assert.equal(get('batch-files').children.length, 2);
  get('batch-files').children[1].click();
  assert.equal(ui.S.result, second);
  await get('btn-copy-share').click();
  assert.equal(get('copy-dialog').open, true);
  assert.match(get('manual-copy').value, /提取链接：http:\/\/localhost\/\?code=111111/);
  assert.doesNotMatch(get('manual-copy').value, /private-token/);
  get('btn-close-copy').click();
  assert.equal(get('copy-dialog').open, false);
  get('btn-delete').click();
  assert.equal(get('delete-confirm').style.display, 'block');
  await get('btn-delete-confirm').click();
  assert.equal(second.deleted, true);
  assert.equal(get('btn-delete').disabled, true);
  assert.equal(requests.at(-1).opts.headers['X-Delete-Token'], 'private-token');
  ui.S.result = first;
  ui.showResult('retrieve');
  assert.equal(get('result-extract-block').style.display, 'none');
  assert.equal(get('btn-copy-share').style.display, 'none');
  assert.equal(get('btn-download').style.display, 'inline-block');
  assert.equal(get('btn-delete').style.display, 'none');
  first.expiresAt = Date.now() - 1;
  ui.startResultCountdown();
  assert.equal(get('btn-download').disabled, true);
  first.expiresAt = Date.now() + 60000;
  ui.showResult('retrieve');
  assert.equal(get('btn-download').disabled, false);
  assert.equal(get('countdown').classList.contains('expired'), false);
});
