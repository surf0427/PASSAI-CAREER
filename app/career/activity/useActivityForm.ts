'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { saveActivityData, loadActivityData, clearActivityData } from './activityStorage';
import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { validateActivityForm } from '@/lib/activityValidator';
import type { BasicInfo } from '@/types/basicInfo';
import type {
  ActivityData,
  ClubActivity,
  VolunteerActivity,
  StudyAbroadActivity,
  ResearchActivity,
  PartTimeJobActivity,
  CertificationActivity,
  ContestActivity,
  ReadingActivity,
  HobbyActivity,
  OtherActivity,
} from '@/types/activity';
import {
  newClubActivity,
  newVolunteerActivity,
  newStudyAbroadActivity,
  newResearchActivity,
  newPartTimeJobActivity,
  newCertificationActivity,
  newContestActivity,
  newReadingActivity,
  newHobbyActivity,
  newOtherActivity,
} from '@/lib/activityFactories';

const initialActivityData: ActivityData = {
  clubActivities: [],
  volunteerActivities: [],
  studyAbroadActivities: [],
  researchActivities: [],
  partTimeJobActivities: [],
  certificationActivities: [],
  contestActivities: [],
  readingActivities: [],
  hobbyActivities: [],
  otherActivities: [],
};

// マウント前 false / マウント後 true を返す flag。
// loadBasicInfo() は localStorage 依存のため SSR では null を返したい。
// useSyncExternalStore の getServerSnapshot/getSnapshot で setState なしにこの semantics を表現する。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export function useActivityForm() {
  const router = useRouter();
  const [activityData, setActivityData] = useState<ActivityData>(
    () => loadActivityData() ?? initialActivityData,
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [isSubmitted, setIsSubmitted] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSuccess, setIsSuccess] = useState<boolean>(false);

  // マウント前は null、マウント後に就活版 loadBasicInfo() の値（保存値 or null）を返す。
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );
  const basicInfo = useMemo<BasicInfo | null>(
    () => (isMounted ? loadBasicInfo() : null),
    [isMounted],
  );

  // 変更検知: 入力のたびに自動保存。初回レンダー時はスキップ（復元前の空データ上書き防止）。
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    saveActivityData(activityData);
  }, [activityData]);

  function handleReset() {
    clearActivityData();
    setActivityData(initialActivityData);
    setErrors([]);
  }

  // ── 部活動 ──────────────────────────────────────────────────────────────────

  function addClubActivity() {
    setActivityData((prev) => ({ ...prev, clubActivities: [...prev.clubActivities, newClubActivity()] }));
  }
  function removeClubActivity(index: number) {
    setActivityData((prev) => ({ ...prev, clubActivities: prev.clubActivities.filter((_, i) => i !== index) }));
  }
  function updateClubActivity(index: number, field: keyof Omit<ClubActivity, 'type' | 'period'>, value: string) {
    setActivityData((prev) => ({
      ...prev,
      clubActivities: prev.clubActivities.map((item, i) =>
        i === index ? ({ ...item, [field]: value } as ClubActivity) : item
      ),
    }));
  }
  function updateClubPeriod(index: number, field: 'from' | 'to', value: string) {
    setActivityData((prev) => ({
      ...prev,
      clubActivities: prev.clubActivities.map((item, i) =>
        i === index ? { ...item, period: { ...item.period, [field]: value } } : item
      ),
    }));
  }

  // ── ボランティア ─────────────────────────────────────────────────────────────

  function addVolunteerActivity() {
    setActivityData((prev) => ({ ...prev, volunteerActivities: [...prev.volunteerActivities, newVolunteerActivity()] }));
  }
  function removeVolunteerActivity(index: number) {
    setActivityData((prev) => ({ ...prev, volunteerActivities: prev.volunteerActivities.filter((_, i) => i !== index) }));
  }
  function updateVolunteerActivity(index: number, field: keyof Omit<VolunteerActivity, 'type' | 'period'>, value: string) {
    setActivityData((prev) => ({
      ...prev,
      volunteerActivities: prev.volunteerActivities.map((item, i) =>
        i === index ? ({ ...item, [field]: value } as VolunteerActivity) : item
      ),
    }));
  }

  // ── 留学 ────────────────────────────────────────────────────────────────────

  function addStudyAbroadActivity() {
    setActivityData((prev) => ({ ...prev, studyAbroadActivities: [...prev.studyAbroadActivities, newStudyAbroadActivity()] }));
  }
  function removeStudyAbroadActivity(index: number) {
    setActivityData((prev) => ({ ...prev, studyAbroadActivities: prev.studyAbroadActivities.filter((_, i) => i !== index) }));
  }
  function updateStudyAbroadActivity(index: number, field: keyof Omit<StudyAbroadActivity, 'type' | 'period'>, value: string) {
    setActivityData((prev) => ({
      ...prev,
      studyAbroadActivities: prev.studyAbroadActivities.map((item, i) =>
        i === index ? ({ ...item, [field]: value } as StudyAbroadActivity) : item
      ),
    }));
  }
  function updateStudyAbroadPeriod(index: number, field: 'from' | 'to', value: string) {
    setActivityData((prev) => ({
      ...prev,
      studyAbroadActivities: prev.studyAbroadActivities.map((item, i) =>
        i === index ? { ...item, period: { ...item.period, [field]: value } } : item
      ),
    }));
  }

  // ── 探究 ────────────────────────────────────────────────────────────────────

  function addResearchActivity() {
    setActivityData((prev) => ({ ...prev, researchActivities: [...prev.researchActivities, newResearchActivity()] }));
  }
  function removeResearchActivity(index: number) {
    setActivityData((prev) => ({ ...prev, researchActivities: prev.researchActivities.filter((_, i) => i !== index) }));
  }
  function updateResearchActivity(index: number, field: keyof Omit<ResearchActivity, 'type' | 'period'>, value: string) {
    setActivityData((prev) => ({
      ...prev,
      researchActivities: prev.researchActivities.map((item, i) =>
        i === index ? ({ ...item, [field]: value } as ResearchActivity) : item
      ),
    }));
  }

  // ── アルバイト ───────────────────────────────────────────────────────────────

  function addPartTimeJobActivity() {
    setActivityData((prev) => ({ ...prev, partTimeJobActivities: [...prev.partTimeJobActivities, newPartTimeJobActivity()] }));
  }
  function removePartTimeJobActivity(index: number) {
    setActivityData((prev) => ({ ...prev, partTimeJobActivities: prev.partTimeJobActivities.filter((_, i) => i !== index) }));
  }
  function updatePartTimeJobActivity(index: number, field: keyof Omit<PartTimeJobActivity, 'type' | 'period'>, value: string) {
    setActivityData((prev) => ({
      ...prev,
      partTimeJobActivities: prev.partTimeJobActivities.map((item, i) =>
        i === index ? ({ ...item, [field]: value } as PartTimeJobActivity) : item
      ),
    }));
  }
  function updatePartTimeJobPeriod(index: number, field: 'from' | 'to', value: string) {
    setActivityData((prev) => ({
      ...prev,
      partTimeJobActivities: prev.partTimeJobActivities.map((item, i) =>
        i === index ? { ...item, period: { ...item.period, [field]: value } } : item
      ),
    }));
  }

  // ── 資格 ────────────────────────────────────────────────────────────────────

  function addCertificationActivity() {
    setActivityData((prev) => ({ ...prev, certificationActivities: [...prev.certificationActivities, newCertificationActivity()] }));
  }
  function removeCertificationActivity(index: number) {
    setActivityData((prev) => ({ ...prev, certificationActivities: prev.certificationActivities.filter((_, i) => i !== index) }));
  }
  function updateCertificationActivity(index: number, field: keyof Omit<CertificationActivity, 'type'>, value: string) {
    setActivityData((prev) => ({
      ...prev,
      certificationActivities: prev.certificationActivities.map((item, i) =>
        i === index ? ({ ...item, [field]: value } as CertificationActivity) : item
      ),
    }));
  }

  // ── コンテスト ───────────────────────────────────────────────────────────────

  function addContestActivity() {
    setActivityData((prev) => ({ ...prev, contestActivities: [...prev.contestActivities, newContestActivity()] }));
  }
  function removeContestActivity(index: number) {
    setActivityData((prev) => ({ ...prev, contestActivities: prev.contestActivities.filter((_, i) => i !== index) }));
  }
  function updateContestActivity(index: number, field: keyof Omit<ContestActivity, 'type' | 'period'>, value: string) {
    setActivityData((prev) => ({
      ...prev,
      contestActivities: prev.contestActivities.map((item, i) =>
        i === index ? ({ ...item, [field]: value } as ContestActivity) : item
      ),
    }));
  }

  // ── 読書 ────────────────────────────────────────────────────────────────────

  function addReadingActivity() {
    setActivityData((prev) => ({ ...prev, readingActivities: [...prev.readingActivities, newReadingActivity()] }));
  }
  function removeReadingActivity(index: number) {
    setActivityData((prev) => ({ ...prev, readingActivities: prev.readingActivities.filter((_, i) => i !== index) }));
  }
  function updateReadingActivity(index: number, field: keyof Omit<ReadingActivity, 'type'>, value: string) {
    setActivityData((prev) => ({
      ...prev,
      readingActivities: prev.readingActivities.map((item, i) =>
        i === index ? ({ ...item, [field]: value } as ReadingActivity) : item
      ),
    }));
  }

  // ── 趣味 ────────────────────────────────────────────────────────────────────

  function addHobbyActivity() {
    setActivityData((prev) => ({ ...prev, hobbyActivities: [...prev.hobbyActivities, newHobbyActivity()] }));
  }
  function removeHobbyActivity(index: number) {
    setActivityData((prev) => ({ ...prev, hobbyActivities: prev.hobbyActivities.filter((_, i) => i !== index) }));
  }
  function updateHobbyActivity(index: number, field: keyof Omit<HobbyActivity, 'type'>, value: string) {
    setActivityData((prev) => ({
      ...prev,
      hobbyActivities: prev.hobbyActivities.map((item, i) =>
        i === index ? ({ ...item, [field]: value } as HobbyActivity) : item
      ),
    }));
  }

  // ── その他 ──────────────────────────────────────────────────────────────────

  function addOtherActivity() {
    setActivityData((prev) => ({ ...prev, otherActivities: [...prev.otherActivities, newOtherActivity()] }));
  }
  function removeOtherActivity(index: number) {
    setActivityData((prev) => ({ ...prev, otherActivities: prev.otherActivities.filter((_, i) => i !== index) }));
  }
  function updateOtherActivity(index: number, field: keyof Omit<OtherActivity, 'type' | 'period'>, value: string) {
    setActivityData((prev) => ({
      ...prev,
      otherActivities: prev.otherActivities.map((item, i) =>
        i === index ? ({ ...item, [field]: value } as OtherActivity) : item
      ),
    }));
  }
  function updateOtherPeriod(index: number, field: 'from' | 'to', value: string) {
    setActivityData((prev) => ({
      ...prev,
      otherActivities: prev.otherActivities.map((item, i) =>
        i === index ? { ...item, period: { ...item.period, [field]: value } } : item
      ),
    }));
  }

  // ── 送信 ─────────────────────────────────────────────────────────────────────

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const newErrors = validateActivityForm(activityData);
    if (newErrors.length > 0) {
      setErrors(newErrors);
      return;
    }
    setIsLoading(true);
    await new Promise(resolve => setTimeout(resolve, 600));
    try {
      // 【sessionStorage】AI分析ページへの一時的なデータ受け渡し（就活版専用キーに分離）。
      // 受験版キー 'activityData' とは別の 'careerActivityData' を使い、受験版フローへ
      // 混入しないようにする。SSRガードは不要（ユーザー操作時のみ実行）。
      //
      // 就活版では受験版DB（activity_logs）への dualWrite / Supabase mirror は行わない。
      // ルール「受験版テーブルへ就活データを書き込まない」「新規DBはまだ作らない」に従い、
      // canonical な localStorage 保存（autosave）のみで保持する。
      sessionStorage.setItem('careerActivityData', JSON.stringify(activityData));
    } catch (e) {
      console.error('useActivityForm(career): sessionStorage save failed', e);
      setErrors(['保存に失敗しました。入力内容をコピーしてから再読み込みしてください。']);
      setIsLoading(false);
      return;
    }
    setIsLoading(false);
    setIsSuccess(true);
    await new Promise(resolve => setTimeout(resolve, 800));
    router.push('/career/home');
  }

  function handleBack() {
    setErrors([]);
    setIsSubmitted(false);
  }

  return {
    activityData,
    errors,
    isSubmitted,
    isLoading,
    isSuccess,
    basicInfo,
    handleSubmit,
    handleReset,
    handleBack,
    addClubActivity, removeClubActivity, updateClubActivity, updateClubPeriod,
    addVolunteerActivity, removeVolunteerActivity, updateVolunteerActivity,
    addStudyAbroadActivity, removeStudyAbroadActivity, updateStudyAbroadActivity, updateStudyAbroadPeriod,
    addResearchActivity, removeResearchActivity, updateResearchActivity,
    addPartTimeJobActivity, removePartTimeJobActivity, updatePartTimeJobActivity, updatePartTimeJobPeriod,
    addCertificationActivity, removeCertificationActivity, updateCertificationActivity,
    addContestActivity, removeContestActivity, updateContestActivity,
    addReadingActivity, removeReadingActivity, updateReadingActivity,
    addHobbyActivity, removeHobbyActivity, updateHobbyActivity,
    addOtherActivity, removeOtherActivity, updateOtherActivity, updateOtherPeriod,
  };
}
