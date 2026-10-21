// 仪表盘卡片定义：看板只认 id / label / 组件，卡片内容由各组件自己渲染
import type { Component } from 'vue';
import type { DashboardWidgetHeight, DashboardWidgetWidth } from '../../../services/types';

export interface DashboardWidgetDef {
  id: string;
  label: string;
  component: Component;
  props?: Record<string, unknown>;
  /** 默认布局里的宽度/高度档位（未配置布局时生效） */
  defaultWidth?: DashboardWidgetWidth;
  defaultHeight?: DashboardWidgetHeight;
}
