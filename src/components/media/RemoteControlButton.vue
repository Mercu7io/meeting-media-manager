<template>
  <q-btn
    class="super-rounded"
    :class="classes"
    :color="color"
    rounded
    :text-color="textColor"
    unelevated
    @click="remotePopup = !remotePopup"
  >
    <q-icon name="mmm-stream-play" />
    <q-badge
      v-if="remoteControlRunning && remoteControlClientCount > 0"
      class="q-ml-xs"
      color="secondary"
      floating
      rounded
    >
      {{ remoteControlClientCount }}
    </q-badge>
    <q-tooltip
      v-if="!remotePopup"
      anchor="bottom left"
      :delay="1000"
      :offset="[14, 22]"
      self="top left"
    >
      {{ t('remote-control') }}
    </q-tooltip>
  </q-btn>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import {
  type IslandButtonStatus,
  useIslandButton,
} from 'src/composables/useIslandButton';
import { useCurrentStateStore } from 'stores/current-state';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const currentState = useCurrentStateStore();
const { remoteControlClientCount, remoteControlRunning } =
  storeToRefs(currentState);

const remotePopup = defineModel<boolean>({ required: true });

const { classes, color, textColor } = useIslandButton(
  computed<IslandButtonStatus>(() =>
    remoteControlRunning.value ? 'normal' : 'off',
  ),
  remotePopup,
);
</script>
