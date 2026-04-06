export default class GithubWatchPlugin {
  async onload() {
    const defaults = {
      webhook_secret: "",
      notify_on_pr: true,
      auto_review: true,
      auto_review_agent: "",
      max_events: 100,
    };

    const current = this.ctx.config.get() || {};
    for (const [key, value] of Object.entries(defaults)) {
      if (current[key] === undefined) {
        this.ctx.config.set(key, value);
      }
    }
  }
}
