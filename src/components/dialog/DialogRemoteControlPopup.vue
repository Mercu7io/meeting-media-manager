<template>
  <ActionPopup
    v-model="open"
    :status-color="statusColor"
    :status-icon="statusIcon"
    :status-text="statusText"
    :title="t('remote-control')"
  >
    <div class="q-px-md q-pt-sm q-pb-md">
      <!-- Enable toggle -->
      <div class="row items-center justify-between q-mb-md">
        <div class="col">
          <div class="text-subtitle2 text-weight-medium">
            {{ t('enableRemoteControl') }}
          </div>
          <div class="text-caption text-dark-grey">
            {{ t('enableRemoteControl-explain') }}
          </div>
        </div>
        <q-toggle
          v-if="currentSettings"
          v-model="currentSettings.enableRemoteControl"
          color="primary"
        />
      </div>

      <template v-if="currentSettings?.enableRemoteControl">
        <q-separator class="bg-accent-200 q-my-md" />

        <!-- Port and Scope configuration -->
        <div class="row items-center q-col-gutter-sm q-mb-md">
          <div class="col-12 col-sm-6">
            <q-input
              v-model="currentSettings.remoteControlPort"
              dense
              :label="t('remoteControlPort')"
              outlined
              type="number"
            />
          </div>
          <div class="col-12 col-sm-6">
            <q-select
              v-model="currentSettings.remoteControlScope"
              dense
              emit-value
              :label="t('remoteControlScope')"
              map-options
              :options="scopeOptions"
              outlined
            />
          </div>
        </div>

        <!-- Pairing Code Display -->
        <div
          class="row items-center justify-between q-pa-sm bg-accent-100 rounded-borders q-mb-md"
        >
          <div>
            <div class="text-caption text-weight-medium">
              {{ t('remote-control-pairing-code') }}
            </div>
            <div class="row items-center q-gutter-x-sm">
              <div
                class="text-h5 text-primary text-weight-bold"
                style="letter-spacing: 0.15em"
              >
                {{ remoteControlPairingCode || '------' }}
              </div>
              <q-btn
                v-if="remoteControlRunning"
                :aria-label="t('remote-control-generate-new-pin')"
                color="primary"
                dense
                flat
                icon="mmm-refresh"
                round
                size="sm"
                @click="handleRegeneratePin"
              >
                <q-tooltip :delay="500">{{
                  t('remote-control-generate-new-pin')
                }}</q-tooltip>
              </q-btn>
            </div>
          </div>
          <div class="text-caption text-dark-grey text-right col-6">
            {{ t('remote-control-pairing-code-explain') }}
          </div>
        </div>

        <!-- Active Controller & Emergency Kill Switch -->
        <div
          v-if="remoteControlRunning"
          class="row items-center justify-between q-mb-md"
        >
          <div>
            <div class="text-caption text-dark-grey">
              {{ t('remote-control-active-controller') }}
            </div>
            <div class="row items-center q-gutter-x-xs">
              <div class="text-body2 text-weight-bold">
                {{
                  remoteControlActiveController ||
                  t('remote-control-no-controller')
                }}
              </div>
              <q-btn
                v-if="remoteControlActiveController"
                :aria-label="t('remote-control-remove-controller')"
                color="negative"
                dense
                flat
                icon="mmm-close"
                round
                size="xs"
                @click="handleRemoveActiveController"
              >
                <q-tooltip :delay="500">{{
                  t('remote-control-remove-controller')
                }}</q-tooltip>
              </q-btn>
            </div>
          </div>
          <q-btn
            v-if="remoteControlClientCount > 0"
            color="negative"
            dense
            no-caps
            outline
            size="sm"
            @click="handleDisconnectAll"
          >
            {{ t('remote-control-disconnect-all') }}
          </q-btn>
        </div>

        <!-- Network URLs & QR Code -->
        <template v-if="remoteControlRunning">
          <q-separator class="bg-accent-200 q-my-md" />

          <p class="card-section-title text-dark-grey q-mb-xs">
            {{ t('remote-control') }}
          </p>

          <div class="text-caption text-dark-grey q-mb-sm">
            {{
              remoteControlUrls.length
                ? t('remote-control-open-on-device')
                : t('remote-control-no-network')
            }}
          </div>

          <div
            v-for="url in remoteControlUrls"
            :key="url"
            class="row items-center no-wrap q-gutter-x-sm q-mb-xs cursor-pointer q-pa-xs rounded-borders"
            :class="{ 'bg-accent-100': selectedUrl === url }"
            @click="selectUrl(url)"
          >
            <q-radio v-model="selectedUrl" dense size="xs" :val="url" />
            <code class="col ellipsis remote-url__code">{{ url }}</code>
            <q-btn
              :aria-label="t('remote-control-copy')"
              dense
              flat
              icon="mmm-link"
              round
              size="sm"
              @click.stop="copyUrl(url)"
            >
              <q-tooltip :delay="500">{{ t('remote-control-copy') }}</q-tooltip>
            </q-btn>
          </div>

          <!-- Open in local browser button -->
          <div class="q-mt-sm">
            <q-btn
              class="full-width"
              color="primary"
              dense
              icon="mmm-open-web"
              :label="t('remote-control-test-local')"
              no-caps
              outline
              @click="openInBrowser"
            />
          </div>

          <!-- QR Code section (pure URL, no credentials) -->
          <div v-if="qrCodeDataUrl" class="column items-center q-mt-md">
            <div class="qr-container q-pa-xs">
              <img alt="QR Code" class="qr-image" :src="qrCodeDataUrl" />
            </div>
            <div class="text-caption text-dark-grey q-mt-xs text-center">
              {{ t('remote-control-scan-qr') }}
            </div>
          </div>
        </template>
      </template>
    </div>
  </ActionPopup>
</template>

<script setup lang="ts">
import { watchImmediate } from '@vueuse/core';
import { storeToRefs } from 'pinia';
import QRCode from 'qrcode';
import { copyToClipboard } from 'quasar';
import { errorCatcher } from 'src/helpers/error-catcher';
import { createTemporaryNotification } from 'src/helpers/notifications';
import {
  disconnectAllRemoteControlDevices,
  generateNewPairingCode,
  removeActiveController,
} from 'src/helpers/remote-control';
import { useCurrentStateStore } from 'stores/current-state';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import ActionPopup from '../ui/ActionPopup.vue';

const { t } = useI18n();

const open = defineModel<boolean>({ required: true });

const currentState = useCurrentStateStore();
const {
  currentSettings,
  remoteControlActiveController,
  remoteControlClientCount,
  remoteControlPairingCode,
  remoteControlRunning,
  remoteControlUrls,
} = storeToRefs(currentState);

const selectedUrl = ref<string>('');

const scopeOptions = computed(() => [
  { label: t('remote-control-scope-partial'), value: 'partial' },
  { label: t('remote-control-scope-full'), value: 'full' },
]);

const selectUrl = (url: string) => {
  selectedUrl.value = url;
};

const statusColor = computed(() =>
  remoteControlRunning.value ? 'positive' : 'grey',
);

const statusIcon = computed(() =>
  remoteControlRunning.value ? 'mmm-check' : 'mmm-stream-play',
);

const statusText = computed(() => {
  if (!remoteControlRunning.value) {
    return t('remote-control-status-inactive');
  }
  if (remoteControlClientCount.value > 0) {
    return `${t('remote-control-status-active')} · ${t('remote-control-connected-clients')}: ${remoteControlClientCount.value}`;
  }
  return t('remote-control-status-active');
});

const qrCodeDataUrl = ref<string>('');

const generateQr = async () => {
  const primaryUrl = selectedUrl.value || remoteControlUrls.value[0];
  if (!primaryUrl) {
    qrCodeDataUrl.value = '';
    return;
  }

  try {
    qrCodeDataUrl.value = await QRCode.toDataURL(primaryUrl, {
      color: {
        dark: '#1e293b',
        light: '#ffffff',
      },
      margin: 1,
      width: 180,
    });
  } catch (error) {
    errorCatcher(error, { contexts: { fn: { name: 'generateQr' } } });
  }
};

const copyUrl = async (url: string) => {
  try {
    await copyToClipboard(url);
    createTemporaryNotification({
      group: 'remote-control',
      icon: 'mmm-link',
      message: t('remote-control-copied'),
      type: 'positive',
    });
  } catch (error) {
    errorCatcher(error, { contexts: { fn: { name: 'copyUrl' } } });
  }
};

const openInBrowser = () => {
  const target =
    selectedUrl.value ||
    remoteControlUrls.value[0] ||
    `http://localhost:${currentSettings.value?.remoteControlPort || '8080'}/`;
  if (globalThis.electronApi?.openExternalUrl) {
    globalThis.electronApi.openExternalUrl(target);
  }
};

const handleDisconnectAll = async () => {
  await disconnectAllRemoteControlDevices();
};

const handleRemoveActiveController = async () => {
  await removeActiveController();
  createTemporaryNotification({
    group: 'remote-control',
    icon: 'mmm-check',
    message: t('remote-control-controller-removed'),
    type: 'positive',
  });
};

const handleRegeneratePin = async () => {
  const newPin = await generateNewPairingCode();
  if (newPin) {
    createTemporaryNotification({
      group: 'remote-control',
      icon: 'mmm-check',
      message: t('remote-control-pin-regenerated'),
      type: 'positive',
    });
  }
};

const refreshStatus = async () => {
  if (globalThis.electronApi?.getRemoteControlStatus) {
    try {
      const status = await globalThis.electronApi.getRemoteControlStatus();
      currentState.setRemoteControlStatus({
        activeControllerName: status.activeControllerName || '',
        clientCount: status.clientCount,
        pairingCode: status.pairingCode,
        running: status.running,
        urls: status.urls,
      });
    } catch (error) {
      errorCatcher(error, { contexts: { fn: { name: 'refreshStatus' } } });
    }
  }
};

watch(open, (isOpen) => {
  if (isOpen) {
    void refreshStatus();
  }
});

watchImmediate(
  () => [
    remoteControlUrls.value,
    remoteControlRunning.value,
    selectedUrl.value,
  ],
  () => {
    if (
      !selectedUrl.value ||
      !remoteControlUrls.value.includes(selectedUrl.value)
    ) {
      selectedUrl.value = remoteControlUrls.value[0] || '';
    }
    void generateQr();
  },
);
</script>

<style scoped>
.remote-url__code {
  font-size: 0.85em;
  min-width: 0;
}

.qr-container {
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.qr-image {
  display: block;
  height: 180px;
  width: 180px;
}
</style>
