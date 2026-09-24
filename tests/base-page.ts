import type { Page } from "playwright";

export class BasePage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async goto() {
    await this.page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:8787");
  }
}
