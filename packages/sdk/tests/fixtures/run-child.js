import { sdk } from "../../dist/index.js";

// 子程序：回显 runInput 的 input 与 config
const { input, config } = sdk.runInput();
sdk.return({ echo: input, config });
