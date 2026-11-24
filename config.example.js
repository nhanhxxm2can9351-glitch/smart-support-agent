/* 云端公开配置模板 —— 复制为 config.js 后填入你自己应用的 publicConfig
 *
 * 获取方式：在 WorkBuddy 中激活云服务后，从返回的 publicConfig 中取值。
 * 注意：服务端执行精确 Origin 匹配，这些值只在激活时预留的域名下生效。
 * config.js 已被 .gitignore 排除，请勿把真实值提交到仓库。
 */
window.PUBLIC_CONFIG = {
  endpoint: 'https://<your-app>.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_<your-publishable-key>',
  applicationId: 'wbapp_<your-application-id>'
};
