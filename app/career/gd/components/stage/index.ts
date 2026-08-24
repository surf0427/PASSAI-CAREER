// GD「Forest Circle」ステージ（presentation layer）の公開 API。
export { GdCircleStage } from './GdCircleStage';
export { ParticipantAvatar } from './ParticipantAvatar';
export { ForestBackdrop } from './ForestBackdrop';
export { computeGdSeats, seatSizeFactor, type GdSeat } from './seatLayout';
export { useRecentSpeaker } from './useRecentSpeaker';
export type { GdStageParticipant, GdStageSpeech, GdStageSeatTestHook } from './types';
