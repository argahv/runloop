# task-store

A tiny in-memory task store with no dependencies.

## API

`createStore()` returns a store with these methods:

| Method         | Behaviour                                                              |
| -------------- | ---------------------------------------------------------------------- |
| `add(title)`   | Adds a task `{ id, title, done: false }` and returns it. Ids are unique. Throws a `TypeError` for an empty title. |
| `get(id)`      | Returns the task with that id, or `undefined`.                         |
| `all()`        | Returns every task in insertion order, as a new array.                 |
| `complete(id)` | Marks the task as done and returns it. Throws for an unknown id.       |
| `listOpen()`   | Returns the tasks that are not done, in insertion order.               |

## Tests

```sh
node --test --test-reporter=tap
```

`src/task-store.js` is still a stub, so every test fails until it is implemented.
