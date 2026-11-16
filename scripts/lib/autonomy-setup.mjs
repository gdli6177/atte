/** Waits for the retained workspace snapshot after first-launch setup. */
export async function waitForWorkspace(page) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const workspace = await page.evaluate(() =>
      window.atte.environment().then(value => value.workspace),
    );
    if (workspace) {
      await page.waitForFunction(() =>
        window.atte.command({ type: "snapshot" })
          .then(state => Number.isInteger(state.version) && state.version >= 5),
      );
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("测试工作区未在 30 秒内打开");
}
