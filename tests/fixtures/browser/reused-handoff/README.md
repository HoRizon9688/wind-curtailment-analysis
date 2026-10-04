# 经独立核验的交接合成输入

来源为用户提供的 `files/浏览器计算改造_T1-T3交接/t3_handoff`（2026-09-29 交接），这里仅保留合成 CSV 与场景输入，没有复制重建的 Python 参照、其期望结果或 xlsx 依赖。`scenarios.json` 是原 `scenarios.py` 中 SCENARIOS 的 20 条字面量，不含执行代码。

原始字节 SHA-256：

- fixtures_power.csv：`44782be682be71f00f5dc1d35d71da5a1508af0f960099513a01c06951bac8d0`
- fixtures_forecast.csv：`f7edc3876fd5f905f709c558af26bc406d3bb83e2177e4b40d3974911d1c680a`

测试 `tests/browser/differential.test.mjs` 使用当前仓库实际 Python 实现作为独立只读参照，并比较整个 Result。正确的合成全天缺失区间数量为 4；交接包重建参照输出的 36 个重复区间不予复用。T1 冻结样例和容差没有修改。
