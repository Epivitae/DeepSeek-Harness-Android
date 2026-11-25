/* Locale selection, static labels, and Russian time inflection without a server. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/i18n.js', import.meta.url), 'utf8');

function load(language) {
  const context = { window: {}, navigator: { language }, Intl, Date };
  vm.runInNewContext(source, context);
  return { ...context, i18n: context.window.DSHI18n };
}

const russian = load('ru-RU');
assert.equal(russian.i18n.t('settings'), 'Настройки');
assert.equal(russian.i18n.t('sessionCountSuffix'), '');
assert.equal(russian.i18n.t('missing'), '');
assert.equal(load('ru').i18n.t('newChat'), 'Новый диалог');
assert.equal(load('zh-CN').i18n.t('settings'), '设置');
assert.equal(load('en-US').i18n.t('settings'), '设置');
assert.equal(russian.i18n.relativeTime(0), '');
assert.equal(russian.i18n.relativeTime(Date.now() + 60000), 'Только что');
for (const [minutes, expected] of [[1, '1 минуту назад'], [2, '2 минуты назад'], [5, '5 минут назад'], [21, '21 минуту назад']]) {
  assert.equal(russian.i18n.relativeTime(Date.now() - minutes * 60000 - 100), expected);
}
assert.equal(load('zh-CN').i18n.relativeTime(Date.now() - 120100), '2 分钟前');

const label = { textContent: '', getAttribute: () => 'newChat' };
const attributes = new Map();
const suggestion = { getAttribute: () => 'suggestTests', setAttribute: (key, value) => attributes.set(key, value) };
const root = {
  querySelectorAll(selector) {
    if (selector === '[data-i18n]') return [label];
    if (selector === '[data-i18n-suggest]') return [suggestion];
    return [];
  }
};
russian.document = { documentElement: {} };
// The classic script resolves document from its execution context.
const context = { window: {}, navigator: { language: 'ru' }, document: russian.document, Intl, Date };
vm.runInNewContext(source, context);
context.window.DSHI18n.localize(root);
assert.equal(label.textContent, 'Новый диалог');
assert.equal(attributes.get('data-suggest'), 'Запусти тесты и исправь ошибки');
assert.equal(context.document.documentElement.lang, 'ru');
console.log('i18n tests passed');
