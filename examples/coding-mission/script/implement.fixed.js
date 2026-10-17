// In-memory task store (see README.md for the API).
export function createStore() {
  const tasks = [];
  let nextId = 1;

  const find = (id) => tasks.find((t) => t.id === id);

  return {
    add(title) {
      if (typeof title !== 'string' || title.trim() === '') {
        throw new TypeError('title must be a non-empty string');
      }
      const task = { id: nextId++, title, done: false };
      tasks.push(task);
      return task;
    },
    get(id) {
      return find(id);
    },
    all() {
      return [...tasks];
    },
    complete(id) {
      const task = find(id);
      if (!task) throw new Error(`unknown task: ${id}`);
      task.done = true;
      return task;
    },
    listOpen() {
      return tasks.filter((t) => !t.done);
    },
  };
}
