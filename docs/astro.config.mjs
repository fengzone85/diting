import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// 站点部署在 GitHub Pages 项目子路径 fengzone85.github.io/diting/，因此必须设置 base。
export default defineConfig({
  site: 'https://fengzone85.github.io',
  base: '/diting/',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: '谛听 · DiTing',
      description: '自托管 Docker 监控 · 受控端零入站 · 无指令通道',
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
      },
      logo: {
        src: './src/assets/logo.png',
        alt: '谛听 DiTing',
      },
      favicon: '/favicon.ico',
      social: {
        github: 'https://github.com/fengzone85/diting',
      },
      lastUpdated: true,
      sidebar: [
        {
          label: '开始',
          items: [
            { label: '简介', slug: 'intro' },
            { label: '快速开始', slug: 'quick-start' },
            { label: '安装指南', slug: 'install' },
          ],
        },
        {
          label: '部署',
          items: [
            { label: '服务端部署', slug: 'server' },
            { label: '受控端部署', slug: 'agent' },
            { label: '原生 Linux 部署', slug: 'native' },
            { label: 'Windows 部署', slug: 'windows' },
          ],
        },
        {
          label: '配置与安全',
          items: [
            { label: '环境变量', slug: 'env' },
            { label: '安全设计', slug: 'security' },
            { label: '隐藏源站 IP', slug: 'tunnel-guide' },
            { label: 'API 接口', slug: 'api' },
          ],
        },
        {
          label: '其它',
          items: [{ label: 'FAQ', slug: 'faq' }],
        },
      ],
    }),
  ],
});
