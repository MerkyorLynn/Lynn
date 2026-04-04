declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";

  interface TaskListOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }

  type TaskListPlugin = (md: MarkdownIt, options?: TaskListOptions) => void;

  const plugin: TaskListPlugin;
  export default plugin;
}
