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

        <!-- Port configuration -->
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
            <q-toggle
              v-model="currentSettings.remoteControlRequirePin"
              color="primary"
              :label="t('remoteControlRequirePin')"
            />
          </div>
        </div>

        <!-- PIN configuration -->
        <div
          v-if="currentSettings.remoteControlRequirePin"
          class="row items-center q-col-gutter-sm q-mb-md"
        >
          <div class="col-8">
            <q-input
              v-model="currentSettings.remoteControlPin"
              dense
              :label="t('remoteControlPin')"
              maxlength="8"
              outlined
            />
          </div>
          <div class="col-4">
            <q-btn
              class="full-width"
              color="primary"
              dense
              no-caps
              outline
              @click="regeneratePin"
            >
              {{ t('regenerate-pin') }}
            </q-btn>
          </div>
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

          <!-- QR Code section -->
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
import { generateRandomPin } from 'src/helpers/remote-control';
import { useCurrentStateStore } from 'stores/current-state';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import ActionPopup from '../ui/ActionPopup.vue';

const { t } = useI18n();

const open = defineModel<boolean>({ required: true });

const currentState = useCurrentStateStore();
const {
  currentSettings,
  remoteControlClientCount,
  remoteControlRunning,
  remoteControlUrls,
} = storeToRefs(currentState);

const selectedUrl = ref<string>('');

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

  const pin = currentSettings.value?.remoteControlRequirePin
    ? currentSettings.value?.remoteControlPin
    : undefined;

  const targetUrl = pin
    ? `${primaryUrl}?pin=${encodeURIComponent(pin)}`
    : primaryUrl;

  try {
    qrCodeDataUrl.value = await QRCode.toDataURL(targetUrl, {
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
    const pin = currentSettings.value?.remoteControlRequirePin
      ? currentSettings.value?.remoteControlPin
      : undefined;
    const targetUrl = pin ? `${url}?pin=${encodeURIComponent(pin)}` : url;
    await copyToClipboard(targetUrl);
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
  const base =
    selectedUrl.value ||
    remoteControlUrls.value[0] ||
    `http://localhost:${currentSettings.value?.remoteControlPort || '8080'}/`;
  const pin = currentSettings.value?.remoteControlRequirePin
    ? currentSettings.value?.remoteControlPin
    : undefined;
  const target = pin ? `${base}?pin=${encodeURIComponent(pin)}` : base;
  if (globalThis.electronApi?.openExternalUrl) {
    globalThis.electronApi.openExternalUrl(target);
  } else {
    window.open(target, '_blank');
  }
};

const regeneratePin = () => {
  if (currentSettings.value) {
    currentSettings.value.remoteControlPin = generateRandomPin();
  }
};

watchImmediate(
  () => [
    remoteControlUrls.value,
    currentSettings.value?.remoteControlPin,
    currentSettings.value?.remoteControlRequirePin,
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
