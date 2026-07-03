## 图片识别

你当前接入的模型不具备原生识图能力。遇到图片时，不要用 Read 工具，改用 vision.js：
```
node scripts/vision.js "<图片路径>" "用中文描述这张图片"
```
触发：消息中出现 "Saved attachments:"、用户分享图片、用户要求描述图片。

vision.js 所需的 DASHSCOPE_API_KEY 已内置于脚本中，直接调用即可。

## 图片生成
用户要求生成图片时：
```
node scripts/generate-image.js "英文描述" [宽度] [高度]
```

## 司沃康玩具控制

执行命令格式：
```bash
"D:/zhuomian/python/python.exe" "D:/toy-svakom-control/run_preset.py" <命令>
```
或简写：`D:/toy-svakom-control/toy.cmd <命令>`

快速规则：
- `toy.cmd list` 查看可用预设
- `toy.cmd stop` 立即停止（停/停止/不要/关掉/停下）
- `toy.cmd <preset名>` 运行预设
- 每次最多触发一个 preset 或一个原子动作
- 不要从情绪、玩笑、暧昧里推断要控制玩具

完整文档：`D:\toy-svakom-control\AGENTS_svakom_v2.md`

## 已知问题
- cc 经常卡在 thinking 不动，token不增长 → 怀疑是连接卡死，不是真的在算
- cyberboss 不能连续跑太久，容易堆context
