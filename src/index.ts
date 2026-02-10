/**
 * 入口文件
 *
 * 本文件为默认扩展入口文件，如果你想要配置其它文件作为入口文件，
 * 请修改 `extension.json` 中的 `entry` 字段；
 *
 * 请在此处使用 `export`  导出所有你希望在 `headerMenus` 中引用的方法，
 * 方法通过方法名与 `headerMenus` 关联。
 *
 * 如需了解更多开发细节，请阅读：
 * https://prodocs.lceda.cn/cn/api/guide/
 */
import { marked } from 'marked';
import * as extensionConfig from '../extension.json';

// 消息总线主题
const TOPIC_PREVIEW_DATA = 'sch-pin-exporter:preview-data';
const TOPIC_PREVIEW_ACTION = 'sch-pin-exporter:preview-action';
const IFRAME_ID = 'sch-pin-exporter-preview';

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('EasyEDA extension SDK v', undefined, undefined, extensionConfig.version),
		eda.sys_I18n.text('About'),
	);
}

/**
 * 引脚类型中文映射
 */
const PIN_TYPE_MAP = {
	'IN': '➡️ 输入',
	'OUT': '⬅️ 输出',
	'BI': '↔️ 双向',
	'Passive': '⚪ 无源',
	'Open Collector': '🔓 开集电极',
	'Open Emitter': '🔓 开发射极',
	'Power': '⚡ 电源',
	'Ground': '⏚ 地',
	'HIZ': '🚫 高阻',
	'Terminator': '🔚 信号终端',
	'Undefined': '-',
};

/**
 * NetPort 符号 UUID 到类型的映射
 * 通过内部渠道获取的系统内置 netport 符号对应关系
 */
const NETPORT_UUID_TYPE_MAP: Record<string, string> = {
	'a66c3794a6a486ba': '⬅️ 输出',
	'90ef8e566193b790': '↔️ 双向',
	'fdb58b75c536845d': '➡️ 输入',
	// TODO: 补充其他 netport 类型的 uuid 映射
};

/**
 * 根据 NetPort 的 component.uuid 获取其类型名称
 * @param uuid - netport 组件的 uuid
 * @returns 类型名称，未找到则返回 undefined
 */
export function getNetPortTypeByUuid(uuid: string): string | undefined {
	return NETPORT_UUID_TYPE_MAP[uuid];
}

/**
 * 根据名称推断电源/地类型（适用于引脚名称或网络名称）
 * @returns 'Power' | 'Ground' | null
 */
function inferPowerGroundType(name: string): 'Power' | 'Ground' | null {
	if (!name || name === '-')
		return null;

	const upper = name.toUpperCase();

	// 地引脚/网络模式：GND, VSS, DGND, AGND, PGND, EARTH, 0V, EP 等
	if (/^(?:V?SS|D?GND|A?GND|P?GND|EARTH|0V|EP\d*)/.test(upper)
		|| upper.endsWith('GND')
		|| upper === 'GND'
		|| upper === 'EP') {
		return 'Ground';
	}

	// 电源引脚/网络模式：VCC, VDD, VS, V+, +3V3, +5V, VBAT, VBUS, VIN+/-, AVCC, DVCC 等
	if (/^(?:V(?:CC|DD|BAT|BUS|REF|IN|OUT|S)[+-]?|A?VCC|D?VCC|\+?\d+V?\d*|V\+)/.test(upper)
		|| /^[+P]\d/.test(upper)
		|| upper === 'VS') {
		return 'Power';
	}

	return null;
}

/**
 * 综合引脚名称、pinType 和网络名称获取最终的引脚类型显示字符串
 *
 * 优先级：
 * 1. 引脚名称（最可靠，因为配置引脚可能连到 VCC/GND 但本身不是电源/地）
 * 2. 原始 pinType（元件库定义的类型）
 * 3. 网络名称仅用于细分 Power/Ground（当 pinType 为 Power 时区分是电源还是地）
 */
function getPinTypeDisplay(pinType: string, pinName: string, netName: string): string {
	// 1. 优先从引脚名称推断（最可靠）
	const inferredFromName = inferPowerGroundType(pinName);
	if (inferredFromName) {
		return PIN_TYPE_MAP[inferredFromName];
	}

	// 2. 当 pinType 为 Power/Ground 时，用网络名称细分（Power 类引脚可能实际是地）
	if (pinType === 'Power' || pinType === 'Ground') {
		const inferredFromNet = inferPowerGroundType(netName);
		return PIN_TYPE_MAP[inferredFromNet ?? pinType];
	}

	// 3. 使用原始 pinType
	return PIN_TYPE_MAP[pinType as keyof typeof PIN_TYPE_MAP] || pinType;
}

/**
 * 有效的元件位号前缀列表
 * @todo 未来可考虑从配置中获取
 */
const VAILID_DESIGNATOR_LIST = ['U'];

/**
 * 需要排除的元件名称关键词（大写匹配）
 * 二维码标识、排针排母、连接器等非芯片元件
 */
const EXCLUDED_NAME_KEYWORDS = [
	'二维码',
	'QR',
	'排针',
	'排母',
	'排座',
	'插针',
	'插座',
	'WAFER',
	'HEADER',
	'CONNECTOR',
];

/**
 * 判断元件是否应被排除（非功能性芯片）
 */
function isExcludedComponent(name: string, description: string): boolean {
	const upperName = name.toUpperCase();
	const upperDesc = description.toUpperCase();
	return EXCLUDED_NAME_KEYWORDS.some(kw =>
		upperName.includes(kw) || upperDesc.includes(kw),
	);
}

/**
 * 网表 JSON 数据结构
 */
interface NetlistJson {
	version: string;
	components: Record<string, {
		props: {
			Designator: string;
			[key: string]: string;
		};
		pinInfoMap: Record<string, {
			name: string;
			number: string;
			net: string;
		}>;
	}>;
}

/**
 * NetPort 信息结构
 */
interface NetPortInfo {
	primitiveId: string;
	net: string;
	x: number;
	y: number;
	componentRef?: {
		libraryUuid: string;
		uuid: string;
	};
	symbolRef?: {
		libraryUuid: string;
		uuid: string;
	};
	/** 完整的 ILIB_SymbolItem，用于调试 */
	symbolItem?: {
		libraryType: string;
		uuid: string;
		libraryUuid: string;
		cbbUuid?: string;
		name: string;
		classification?: unknown;
		type: number;
		description?: string;
	};
}

/**
 * 解析网表 JSON 数据，建立 "位号-引脚编号" 到 "网络名" 的映射
 */
function parseNetlistToMap(netlistStr: string): Map<string, string> {
	const pinNetMap = new Map<string, string>();

	try {
		const netlist: NetlistJson = JSON.parse(netlistStr);

		for (const uniqueId in netlist.components) {
			const component = netlist.components[uniqueId];
			const designator = component.props.Designator;

			if (!designator)
				continue;

			for (const pinNumber in component.pinInfoMap) {
				const pinInfo = component.pinInfoMap[pinNumber];
				const netName = pinInfo.net;

				if (netName) {
					// 建立 "位号-引脚编号" -> "网络名" 的映射
					const key = `${designator}-${pinNumber}`;
					pinNetMap.set(key, netName);
				}
			}
		}
	}
	catch {
		// JSON 解析失败，返回空映射
	}

	return pinNetMap;
}

/**
 * 收集所有 netport 组件信息
 * @param allComponents - 所有原理图组件
 * @returns 网络名称 -> NetPort 信息列表的映射
 */
async function collectNetPorts(
	allComponents: Awaited<ReturnType<typeof eda.sch_PrimitiveComponent.getAll>>,
): Promise<Map<string, NetPortInfo[]>> {
	const netPortMap = new Map<string, NetPortInfo[]>();

	// 过滤出 netport 类型的组件
	const netports = allComponents.filter(c => c.getState_ComponentType() === 'netport');

	console.warn(`[collectNetPorts] 找到 ${netports.length} 个 netport 组件`);

	for (const netport of netports) {
		const net = netport.getState_Net();
		if (!net)
			continue;

		const primitiveId = netport.getState_PrimitiveId();
		const x = netport.getState_X();
		const y = netport.getState_Y();
		const componentRef = netport.getState_Component();
		const symbolRef = netport.getState_Symbol();

		console.warn(`[NetPort ${primitiveId}] net=${net}, componentRef=${JSON.stringify(componentRef)}, symbolRef=${JSON.stringify(symbolRef)}`);

		const info: NetPortInfo = {
			primitiveId,
			net,
			x,
			y,
			componentRef,
			symbolRef,
		};

		// 添加到映射
		const list = netPortMap.get(net) || [];
		list.push(info);
		netPortMap.set(net, list);
	}

	return netPortMap;
}

/**
 * 计算两点间的欧几里得距离
 */
function distance(x1: number, y1: number, x2: number, y2: number): number {
	return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

/**
 * 根据引脚坐标找到最近的 NetPort
 * @param pinX - 引脚 X 坐标
 * @param pinY - 引脚 Y 坐标
 * @param netPorts - 同一网络的 NetPort 列表
 * @param maxDistance - 最大匹配距离阈值
 * @returns 最近的 NetPort 或 undefined
 */
function findClosestNetPort(
	pinX: number,
	pinY: number,
	netPorts: NetPortInfo[],
	maxDistance = 100,
): NetPortInfo | undefined {
	if (!netPorts || netPorts.length === 0)
		return undefined;

	let closest: NetPortInfo | undefined;
	let minDist = Infinity;

	for (const np of netPorts) {
		const dist = distance(pinX, pinY, np.x, np.y);
		if (dist < minDist && dist <= maxDistance) {
			minDist = dist;
			closest = np;
		}
	}

	return closest;
}

/**
 * 导出原理图芯片引脚到Markdown
 *
 * 遍历当前原理图中的所有元件，提取芯片及其引脚信息，生成Markdown文档。
 * 适用于核对硬件设计和交付给AI进行软件开发。
 */
export async function exportSchematicPinout(): Promise<void> {
	try {
		// 获取网表数据，用于查询引脚连接的网络
		const netlistFile = await eda.sch_ManufactureData.getNetlistFile();
		if (!netlistFile) {
			eda.sys_Dialog.showInformationMessage('无法获取网表文件', '导出引脚');
			return;
		}
		const netlistStr = await netlistFile.text();
		const pinNetMap = parseNetlistToMap(netlistStr);
		// 获取所有元件
		// 注意：由于 eda.sch_PrimitiveComponent 是联合类型，参数类型不兼容，故不传参数获取全部
		const allComponents = await eda.sch_PrimitiveComponent.getAll(
			undefined,
			true, // allSchematicPages: 获取所有原理图页面
		);

		// 收集所有 netport 信息（按网络名称分组）
		const netPortMap = await collectNetPorts(allComponents);

		// 过滤出 COMPONENT 类型（真正的芯片/器件）
		const components = allComponents.filter(
			c => c.getState_ComponentType() === 'part',
		).filter(
			// 进一步过滤出有效的元件位号
			(c) => {
				const des = c.getState_Designator();
				return !!des && VAILID_DESIGNATOR_LIST.some(prefix =>
					new RegExp(`^${prefix}\\d+([A-Z])?$`, 'i').test(des),
				);
			},
		).filter(
			// 排除非芯片元件（二维码、排针排母等）
			(c) => {
				const name = c.getState_Name() || '';
				const props = c.getState_OtherProperty();
				const description = props?.Description || '';
				return !isExcludedComponent(name, description);
			},
		);

		if (!components || components.length === 0) {
			eda.sys_Dialog.showInformationMessage('当前原理图中没有找到任何元件', '导出引脚');
			return;
		}

		// 收集元件及其引脚信息，用于按引脚数量排序
		const componentDataList = await Promise.all(
			components.map(async (component) => {
				const primitiveId = component.getState_PrimitiveId();
				const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
				return { component, pins: pins || [] };
			}),
		);

		// 按引脚数量降序排序
		const sortedComponentData = componentDataList.sort((a, b) => b.pins.length - a.pins.length);

		// 构建Markdown内容
		const lines = [];
		lines.push('# 原理图芯片引脚列表');
		lines.push('');
		lines.push(`> 导出时间: ${new Date().toLocaleString('zh-CN')}`);
		lines.push(`> 元件总数: ${sortedComponentData.length}`);
		lines.push('');
		lines.push('---');
		lines.push('');

		// 遍历每个元件
		for (const { component, pins } of sortedComponentData) {
			const designator = component.getState_Designator() || '未知位号';

			let name = component.getState_Name() || '未知名称';
			const manufacturer = component.getState_Manufacturer();
			const manufacturerId = component.getState_ManufacturerId();

			if (name === '={Manufacturer Part}' || name === '={Value}' || name === '未知名称') {
				// 优先使用型号，其次使用 subPartName（去除末尾 ".数字" 后缀）
				const subPartName = component.getState_SubPartName();
				name = (subPartName ? subPartName.replace(/\.\d+$/, '') : '') || manufacturerId || name;
			}

			const supplier = component.getState_Supplier();
			const supplierId = component.getState_SupplierId();

			// 元件标题
			lines.push(`## ${designator} - ${name}`);
			lines.push('');

			// 元件基本信息
			if (manufacturer || manufacturerId) {
				lines.push(`- **制造商**: ${manufacturer || '-'}`);
				lines.push(`- **型号**: ${manufacturerId || '-'}`);
			}
			if (supplier || supplierId) {
				lines.push(`- **供应商**: ${supplier || '-'}`);
				lines.push(`- **供应商编号**: ${supplierId || '-'}`);
			}
			// 元件原始数据（JSON）
			// lines.push(`- raw: ${JSON.stringify(component)}`);
			// 元件描述
			const props = component.getState_OtherProperty();
			if (props) {
				const description = props.Description;
				description && lines.push(`- **描述**: ${description}`);
			}
			lines.push('');
			// 引脚信息表格
			if (pins && pins.length > 0) {
				// 按引脚编号排序
				const sortedPins = [...pins].sort((a, b) => {
					const numA = a.getState_PinNumber();
					const numB = b.getState_PinNumber();
					// 尝试数字排序，失败则字符串排序
					const intA = Number.parseInt(numA, 10);
					const intB = Number.parseInt(numB, 10);
					if (!Number.isNaN(intA) && !Number.isNaN(intB)) {
						return intA - intB;
					}
					return numA.localeCompare(numB, undefined, { numeric: true });
				});

				// 引脚表格
				lines.push('### 引脚列表');
				lines.push('');
				lines.push('| 引脚编号 | 引脚名称 | 引脚类型 | 连接网络 |');
				lines.push('|:--------:|:---------|:---------|:---------|');

				for (const pin of sortedPins) {
					const pinNumber = pin.getState_PinNumber();
					const pinName = pin.getState_PinName();
					const pinType = pin.getState_pinType();
					const pinX = pin.getState_X();
					const pinY = pin.getState_Y();

					// 从网表映射中查询该引脚连接的网络
					const pinNetKey = `${designator}-${pinNumber}`;
					const netName = pinNetMap.get(pinNetKey) || '-';

					// 综合引脚名称、pinType 和网络名称判断引脚类型
					let pinTypeStr = getPinTypeDisplay(pinType, pinName, netName);

					// 查找关联的 NetPort，如果有则优先使用 NetPort 的类型
					if (netName !== '-') {
						const candidateNetPorts = netPortMap.get(netName);
						if (candidateNetPorts && candidateNetPorts.length > 0) {
							// 尝试找最近的 netport（坐标验证）
							const closestNetPort = findClosestNetPort(pinX, pinY, candidateNetPorts);
							const matchedNetPort = closestNetPort || candidateNetPorts[0];

							// 获取 NetPort 类型（优先使用 UUID 映射）
							const netPortType = matchedNetPort.componentRef?.uuid
								? getNetPortTypeByUuid(matchedNetPort.componentRef.uuid)
								: undefined;

							// 如果有 NetPort 类型，覆盖引脚类型显示
							if (netPortType) {
								pinTypeStr = netPortType;
							}
						}
					}

					lines.push(`| ${pinNumber} | ${pinName} | ${pinTypeStr} | ${netName} |`);
				}
			}
			else {
				lines.push('*该元件没有引脚信息*');
			}

			lines.push('');
			lines.push('---');
			lines.push('');
		}

		// // 添加 NetPort 调试信息部分
		// lines.push('## [DEBUG] NetPort 信息汇总');
		// lines.push('');
		// lines.push(`> 共收集到 ${netPortMap.size} 个网络的 NetPort`);
		// lines.push('');

		// for (const [netName, netPorts] of netPortMap.entries()) {
		// 	lines.push(`### 网络: ${netName}`);
		// 	lines.push('');
		// 	lines.push(`NetPort 数量: ${netPorts.length}`);
		// 	lines.push('');
		// 	lines.push('```json');
		// 	lines.push(JSON.stringify(netPorts, null, 2));
		// 	lines.push('```');
		// 	lines.push('');
		// }

		// 生成文件内容
		const markdown = lines.join('\n');
		const componentCount = sortedComponentData.length;

		// 使用 marked 渲染 HTML 用于预览
		const html = await marked(markdown);

		// 先关闭可能存在的旧预览窗口
		await eda.sys_IFrame.closeIFrame(IFRAME_ID);

		// 打开预览 IFrame
		await eda.sys_IFrame.openIFrame(
			'/iframe/preview.html',
			900,
			600,
			IFRAME_ID,
			{
				maximizeButton: true,
				grayscaleMask: true,
				buttonCallbackFn: (button) => {
					if (button === 'close') {
						eda.sys_IFrame.closeIFrame(IFRAME_ID);
					}
				},
			},
		);

		// 延迟发送数据，等待 IFrame 加载完成
		setTimeout(() => {
			eda.sys_MessageBus.push(TOPIC_PREVIEW_DATA, {
				html,
				markdown,
				count: componentCount,
			});
		}, 1000);

		// 监听用户操作
		eda.sys_MessageBus.pull(TOPIC_PREVIEW_ACTION, async (data) => {
			await eda.sys_IFrame.closeIFrame(IFRAME_ID);

			if (data?.action === 'export' && data.markdown) {
				const blob = new Blob([data.markdown], { type: 'text/markdown;charset=utf-8' });
				const fileName = `schematic_pinout_${new Date().toISOString().slice(0, 10)}.md`;
				await eda.sys_FileSystem.saveFile(blob, fileName);
				eda.sys_Dialog.showInformationMessage(
					`成功导出 ${componentCount} 个元件的引脚信息`,
					'导出引脚',
				);
			}
		});
	}
	catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		eda.sys_Dialog.showInformationMessage(`导出失败: ${errorMessage}`, '导出引脚');
	}
}
