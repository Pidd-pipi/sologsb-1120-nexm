<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { readDbVersion } from './utils/db';
import { useClockStore } from './stores/clockStore';
import { useStepStore } from './stores/stepStore';
import { useInstrumentStore } from './stores/instrumentStore';

const route = useRoute();
const router = useRouter();
const clockStore = useClockStore();
const stepStore = useStepStore();
const instrumentStore = useInstrumentStore();

const activeMenu = computed(() => {
  if (route.path.startsWith('/clocks')) return '/clocks';
  if (route.path.startsWith('/steps')) return '/steps/new';
  if (route.path.startsWith('/parts')) return '/parts';
  if (route.path.startsWith('/instruments')) return '/instruments';
  if (route.path.startsWith('/tests')) return '/tests';
  return '/clocks';
});

const version = readDbVersion();

// 跨页签/跨场景的仪器变动（停用、补检、改有效期、预约抢占）
// 静默轮询刷新：事务互斥保证正确性，这里只负责让界面尽快跟上
let refreshTimer: number | undefined;

function onSelect(index: string) {
  if (index === '/tests') {
    void router.push('/tests/');
    return;
  }
  void router.push(index);
}

onMounted(() => {
  void clockStore.load();
  void stepStore.load();
  void instrumentStore.load();
  refreshTimer = window.setInterval(() => {
    // 页签隐藏时浏览器已节流，无需额外处理
    void clockStore.load();
    void stepStore.load();
    void instrumentStore.load();
  }, 4000);
});

onBeforeUnmount(() => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
});
</script>

<template>
  <el-container class="app">
    <el-header class="app-header">
      <div class="brand">古钟表维修工序档案</div>
      <el-menu :default-active="activeMenu" mode="horizontal" class="menu" @select="onSelect">
        <el-menu-item index="/clocks">钟表台账</el-menu-item>
        <el-menu-item index="/steps/new">工序录入</el-menu-item>
        <el-menu-item index="/parts">零件清单</el-menu-item>
        <el-menu-item index="/instruments">仪器台账</el-menu-item>
        <el-menu-item index="/tests">走时测试</el-menu-item>
      </el-menu>
      <el-tag size="small" effect="plain">本地结构版本 v{{ version }}</el-tag>
    </el-header>
    <el-main class="app-main">
      <router-view />
    </el-main>
  </el-container>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background: #f6f8fa;
}
.app-header {
  display: flex;
  align-items: center;
  gap: 18px;
  background: #2f3a46;
  color: #f4f6f8;
  height: 60px;
}
.brand {
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
}
.menu {
  flex: 1;
  border-bottom: none;
  background: transparent;
}
:deep(.menu .el-menu-item) {
  color: #d6dde5;
}
:deep(.menu .el-menu-item.is-active) {
  color: #ffffff;
  border-bottom-color: #e7c56b;
}
.app-main {
  padding: 18px 22px 40px;
}
</style>
