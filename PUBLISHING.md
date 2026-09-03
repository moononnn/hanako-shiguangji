# 发布契约

这份文件记录本项目的固定发布流程，避免每次发布时遗漏版本、测试或 CI 对账。

## 版本与发布档位

- `manifest.json` 与 `package.json` 的版本号必须完全一致。
- 每个逻辑独立、可测试、可回滚的改动单独提交，避免把无关改动揉成一个提交。
- 小改动（纯美化、无用户流程变化的小修复、文案微调）：推送 `main` 并创建同版本 tag，不创建 Release。
- 功能级改动或需要用户下载新安装包时：按完整 Release 流程执行。
- 已发布版本不回改、不复用；历史 tag 和 Release 不删除。

## 推送与 CI

在仓库根目录执行：

```powershell
$env:TZ = "Asia/Shanghai"
npm test
Get-ChildItem -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
git grep -n -I -E "[0-9]+@qq\.com"
git config user.email
```

命名红线和邮箱检查都必须没有命中；提交邮箱使用 GitHub noreply 地址。

然后按逻辑提交并推送：

```powershell
git add <本次改动>
git commit -m "<简短、具体的改动说明>"
git push origin main
gh run list --workflow CI --limit 5
```

必须等本次 push 对应的 CI 运行完成且为 `success`；CI 失败时先修复，再重新推送。

## 完整 Release 流程

只有功能级改动或用户需要下载新安装包时执行：

1. 对照 `manifest.json`、`package.json`、tag、CHANGELOG 和 Release 标题核对完整版本号。
2. 生成干净发布目录，只保留 manifest、代码、前端资源、README、许可证和必要声明；排除测试文件、运行时数据、日志、备份、`node_modules` 和本地临时文件。
3. 对干净发布目录运行语法检查、自动测试、命名红线和安装结构检查。
4. 使用 .NET `ZipFile.CreateFromDirectory` 或 7z 打包，禁止用 tar 打 zip；检查 zip 条目不得有 `./`、绝对路径或 `../`。
5. 解压 zip 到独立目录，与打包前的干净发布目录逐文件校验，确认发布树一致。
6. 计算 zip 的 SHA-256。
7. 创建 GitHub Release，标题写清版本和主要内容，并附安装包。
8. 保留上一版产物，发布结果与校验值写入项目记录。

## 受保护内容

- 不上传用户数据、密钥、日志、备份和本地临时文件。
- 分享版插件不修改用户助手的身份或性格文件。
- 检查更新的公开仓库地址必须写在代码中，不能依赖开发者机器上的环境变量。
