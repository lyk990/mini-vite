[EN](README_EN.md)
## mini-vite
mini-vite的所有函数名全都和vite一摸一样,只是我对其中的代码做了一些简化，删除了大部分与功能实现无关的代码和注释,并为一些核心方法加上了我自己的注释

通过此仓库,你能学习到vite以下的几个功能
- ⛪ 通过Esbuild 实现依赖扫描和依赖构建
- 💘 实现vite插件开发机制
- 🌈 实现 Vite的编译构建能力
- 🌻 实现 HMR 服务端和客户端的开发。

## 安装
进入packages/vite目录，并 打包
```shell
pnpm i 
cd .\packages\vite\
pnpm run dev
```
## 启动
返回上一级目录,安装并启动示例项目
````shell
cd ../..
pnpm run i
pnpm run serve # 使用mini-vite启动示例项目
pnpm run dev # 使用vite启动示例项目
````

## 调试
````shell
pnpm run dev  # 调试vite源码
pnpm run serve # 调试mini源码
````