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
import * as extensionConfig from '../extension.json';

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
 * 有效的元件位号前缀列表
 * @todo 未来可考虑从配置中获取
 */
const VAILID_DESIGNATOR_LIST = ['U'];

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

			if (name === '={Manufacturer Part}' || name === '未知名称') {
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
					const pinTypeStr = PIN_TYPE_MAP[pinType] || pinType;
					// 从网表映射中查询该引脚连接的网络
					const pinNetKey = `${designator}-${pinNumber}`;
					const netName = pinNetMap.get(pinNetKey) || '-';
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

		// 生成文件内容
		const markdown = lines.join('\n');
		const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
		const fileName = `schematic_pinout_${new Date().toISOString().slice(0, 10)}.md`;

		// 保存文件
		await eda.sys_FileSystem.saveFile(blob, fileName);

		eda.sys_Dialog.showInformationMessage(
			`成功导出 ${sortedComponentData.length} 个元件的引脚信息`,
			'导出引脚',
		);
	}
	catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		eda.sys_Dialog.showInformationMessage(`导出失败: ${errorMessage}`, '导出引脚');
	}
}
