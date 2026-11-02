// check 程序 fixture：永不返回（配合测试注入的小 checkTimeoutMs 触发 check 阶段超时）
setTimeout(() => {}, 60_000);
