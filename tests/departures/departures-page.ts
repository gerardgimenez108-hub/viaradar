import { BasePage } from "../base-page.ts";

export class DeparturesPage extends BasePage {
  get refresh() {
    return this.page.getByRole("button", { name: "Refresh departures" });
  }
  get line() {
    return this.page.getByLabel("Line", { exact: true });
  }
  get rows() {
    return this.page.getByRole("article");
  }
  async ready() {
    await this.page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#refresh")?.disabled,
    );
  }
}
