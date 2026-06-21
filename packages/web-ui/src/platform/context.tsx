import { createContext, useContext } from 'react';
import type { PlatformAdapter } from './types';
import { browserPlatform } from './defaults';

export const PlatformContext = createContext<PlatformAdapter>(browserPlatform);

/**
 * 获取当前平台适配器。
 * 在没有 PlatformProvider 包裹时自动回退到浏览器默认实现。
 */
export function usePlatform(): PlatformAdapter {
  return useContext(PlatformContext);
}
