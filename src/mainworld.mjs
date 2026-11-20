// 页面主世界执行：patchright 的 page.evaluate 默认落在隔离世界，读不到页面自己的 window 全局。
// 注入脚本、指纹采集、反调试状态都必须走 CDP Runtime.evaluate 的默认上下文（主世界）。
export async function evaluateMainWorld(page, expression) {
  const session = await page.context().newCDPSession(page);
  try {
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.exception?.value || exceptionDetails.text || '主世界执行失败');
    }
    return result?.value;
  } finally {
    await session.detach().catch(() => {});
  }
}
