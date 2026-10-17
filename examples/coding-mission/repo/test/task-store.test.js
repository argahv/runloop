import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStore } from '../src/task-store.js';

test('add returns a task with an id and the given title', () => {
  const store = createStore();
  const task = store.add('write docs');
  assert.equal(task.title, 'write docs');
  assert.notEqual(task.id, undefined);
});

test('add assigns unique ids', () => {
  const store = createStore();
  const ids = ['a', 'b', 'c'].map((title) => store.add(title).id);
  assert.equal(new Set(ids).size, 3);
});

test('new tasks start not done', () => {
  const store = createStore();
  assert.equal(store.add('a').done, false);
});

test('add rejects an empty title', () => {
  const store = createStore();
  assert.throws(() => store.add(''), TypeError);
});

test('get returns the task with that id', () => {
  const store = createStore();
  store.add('a');
  const b = store.add('b');
  assert.equal(store.get(b.id).title, 'b');
});

test('get returns undefined for an unknown id', () => {
  const store = createStore();
  store.add('a');
  assert.equal(store.get(999), undefined);
});

test('all returns tasks in insertion order', () => {
  const store = createStore();
  store.add('a');
  store.add('b');
  store.add('c');
  assert.deepEqual(
    store.all().map((t) => t.title),
    ['a', 'b', 'c'],
  );
});

test('all returns a copy of the list', () => {
  const store = createStore();
  store.add('a');
  store.all().push({ id: 'x', title: 'intruder', done: false });
  assert.equal(store.all().length, 1);
});

test('complete marks a task as done', () => {
  const store = createStore();
  const task = store.add('a');
  store.complete(task.id);
  assert.equal(store.get(task.id).done, true);
});

test('complete throws for an unknown id', () => {
  const store = createStore();
  assert.throws(() => store.complete(42));
});

test('listOpen returns only tasks that are not done', () => {
  const store = createStore();
  store.add('a');
  const b = store.add('b');
  store.add('c');
  store.complete(b.id);
  assert.deepEqual(
    store.listOpen().map((t) => t.title),
    ['a', 'c'],
  );
});

test('listOpen reflects complete()', () => {
  const store = createStore();
  const a = store.add('a');
  store.add('b');
  assert.equal(store.listOpen().length, 2);
  store.complete(a.id);
  assert.deepEqual(
    store.listOpen().map((t) => t.title),
    ['b'],
  );
});
