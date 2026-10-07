// jsdom 补丁：antd 组件必需（matchMedia / ResizeObserver 在 jsdom 中缺省不存在）
// 注意：@testing-library 的 configure 不能放这里——setup 与测试是两个独立 bundle，
// 各持一份 @testing-library/dom；configure 在 tests/helpers.tsx 里（与测试同 bundle）
if (typeof window !== "undefined") {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (typeof globalThis.ResizeObserver !== "function") {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver =
      ResizeObserverStub as unknown as typeof ResizeObserver;
  }
}
