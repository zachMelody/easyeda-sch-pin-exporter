# 更新日志

本文件记录项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.0] - 2026-02-07

### 新增

- NetPort（网络标签）关联功能
  - 收集原理图中所有 netport 类型组件
  - 通过网络名称匹配引脚与 NetPort
  - 通过坐标距离验证匹配准确性
  - 引脚表格新增「网络标签存在」列，显示是否有关联的 NetPort

### 已知问题

- **SDK 限制**：`eda.lib_Symbol.get()` 无法获取 netport 组件的符号信息（ILIB_SymbolItem）
  - `getState_Symbol()` 返回 undefined
  - 通过 `getState_Component()` 获取的 componentRef 调用 `lib_Symbol.get()` 也返回 undefined
  - 目前仅能获取 netport 的基础属性：primitiveId、net、x、y、componentRef
  - 符号名称、类型、描述等信息暂无法获取，待 SDK 修复或提供替代 API

## [1.2.0] - 2026-02-02

### 新增

- Markdown 预览功能
  - 导出前可预览渲染后的引脚列表
  - 使用 marked 库渲染 Markdown
  - 通过 IFrame 弹窗展示预览内容
  - 支持最大化窗口查看
  - 预览确认后再导出文件

## [1.1.0] - 2026-02-02

### 新增

- 引脚类型智能识别
  - 综合 PIN_TYPE 和网络名称判断电源/地引脚
  - 电源网络匹配：VCC、VDD、VBAT、VBUS、VIN+/-、VOUT+/-、+3V3、+5V 等
  - 地网络匹配：GND、VSS、DGND、AGND、PGND 等
  - 修正原始类型标记不准确的引脚（如 Power 类型但实际连接 GND）
- 元件过滤增强
  - 排除二维码标识元件
  - 排除排针、排母、排座等连接器
  - 排除插针、插座、WAFER、HEADER 等非芯片元件

## [1.0.0] - 2026-01-29

### 新增

- 原理图芯片引脚导出功能
  - 自动遍历所有原理图页面
  - 过滤位号前缀为 `U` 的芯片元件
  - 提取引脚编号、名称、类型信息
- 网表解析功能
  - 解析网表 JSON 数据
  - 建立引脚到网络的映射关系
  - 显示每个引脚连接的网络名称
- 元件信息展示
  - 位号、名称、制造商、型号
  - 供应商、供应商编号
  - 元件描述（从 OtherProperty 获取）
- 智能排序
  - 元件按引脚数量降序排列
  - 引脚按编号升序排列（支持数字和字母混合编号）
- 引脚类型 emoji 标识
  - 输入、输出、双向、无源
  - 电源、地、高阻
  - 开集电极、开发射极、信号终端
- 名称智能回退
  - 优先使用型号 (manufacturerId)
  - 其次使用子部件名称 (subPartName，去除末尾 `.数字` 后缀)
- Markdown 格式输出
  - 结构化表格展示引脚信息
  - 包含导出时间和元件总数统计
