import { t as require_execAsync } from "./execAsync-DKuY41FQ.mjs";
import { a as __toCommonJS, n as init_esm, r as __commonJSMin, t as esm_exports } from "./export-DF4vM56-.mjs";

//#region node_modules/.pnpm/@opentelemetry+resources@2.11.0_@opentelemetry+api@1.9.1/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-darwin.js
var require_getMachineId_darwin = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getMachineId = void 0;
	const execAsync_1 = require_execAsync();
	const api_1 = (init_esm(), __toCommonJS(esm_exports));
	async function getMachineId() {
		try {
			const idLine = (await (0, execAsync_1.execAsync)("ioreg -rd1 -c \"IOPlatformExpertDevice\"")).stdout.split("\n").find((line) => line.includes("IOPlatformUUID"));
			if (!idLine) return;
			const parts = idLine.split("\" = \"");
			if (parts.length === 2) return parts[1].slice(0, -1);
		} catch (e) {
			api_1.diag.debug(`error reading machine id: ${e}`);
		}
	}
	exports.getMachineId = getMachineId;
}));

//#endregion
export default require_getMachineId_darwin();

export {  };