# Lynn Website

这是一套可直接部署的静态官网页，包含：

- `index.html`：产品介绍首页
- `download.html`：下载页
- `404.html`：兜底错误页
- `styles.css` / `app.js`：共享样式与交互
- `robots.txt` / `sitemap.xml`：基础 SEO 文件
- `nginx.conf.example`：静态站点部署示例

## 建议部署方式

1. 将 `site/` 目录内容上传到你的静态站点目录，例如 `/var/www/lynn-site`
2. 按实际证书路径调整 `nginx.conf.example`
3. 将 `merkyorlynn.com` 指向站点

## 上线前建议再确认

- `sitemap.xml` 里的正式域名
- 备案号和公安备案号展示
- 下载链接是否已切到你要发布的最新版本
