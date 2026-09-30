import { i as __require, r as __commonJSMin } from "./export-DMo8KJcH.mjs";

//#region node_modules/.pnpm/@opentelemetry+resources@2.11.0_@opentelemetry+api@1.9.1/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/execAsync.js
var require_execAsync = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.execAsync = void 0;
	const child_process = __require("child_process");
	const util = __require("util");
	exports.execAsync = util.promisify(child_process.exec);
}));

//#endregion
export { require_execAsync as t };