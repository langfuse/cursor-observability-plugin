import { a as __toCommonJS, n as init_esm, r as __commonJSMin, t as esm_exports } from "./export-ClA3tmiD.mjs";

//#region node_modules/.pnpm/@opentelemetry+resources@2.11.0_@opentelemetry+api@1.9.1/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId-unsupported.js
var require_getMachineId_unsupported = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getMachineId = void 0;
	const api_1 = (init_esm(), __toCommonJS(esm_exports));
	async function getMachineId() {
		api_1.diag.debug("could not read machine-id: unsupported platform");
	}
	exports.getMachineId = getMachineId;
}));

//#endregion
export default require_getMachineId_unsupported();

export {  };