'use client';

import { useActivityForm } from './useActivityForm';
import ActivityFormHint from '@/components/activity/ActivityFormHint';
import BasicInfoSummary from '@/components/shared/BasicInfoSummary';
import ActivitySubmitSuccess from './ActivitySubmitSuccess';
import ActivityFormActions from '@/components/activity/ActivityFormActions';
import ClubActivitySection from '@/components/activity/ClubActivitySection';
import VolunteerActivitySection from '@/components/activity/VolunteerActivitySection';
import StudyAbroadActivitySection from '@/components/activity/StudyAbroadActivitySection';
import ResearchActivitySection from '@/components/activity/ResearchActivitySection';
import PartTimeJobActivitySection from '@/components/activity/PartTimeJobActivitySection';
import CertificationActivitySection from '@/components/activity/CertificationActivitySection';
import ContestActivitySection from '@/components/activity/ContestActivitySection';
import ReadingActivitySection from '@/components/activity/ReadingActivitySection';
import HobbyActivitySection from '@/components/activity/HobbyActivitySection';
import OtherActivitySection from '@/components/activity/OtherActivitySection';
import { PageHeader } from '@/components/ui/PageHeader';

export default function ActivityPage() {
  const {
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
  } = useActivityForm();

  if (isSubmitted) {
    return <ActivitySubmitSuccess onBack={handleBack} />;
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <PageHeader title="活動整理入力" />

      <BasicInfoSummary basicInfo={basicInfo} />

      <ActivityFormHint />

      <form onSubmit={handleSubmit} noValidate>

        <ClubActivitySection
          activities={activityData.clubActivities}
          errors={errors.filter(e => e.startsWith('部活動'))}
          onAdd={addClubActivity}
          onRemove={removeClubActivity}
          onUpdate={updateClubActivity}
          onUpdatePeriod={updateClubPeriod}
        />

        <VolunteerActivitySection
          activities={activityData.volunteerActivities}
          errors={errors.filter(e => e.startsWith('ボランティア'))}
          onAdd={addVolunteerActivity}
          onRemove={removeVolunteerActivity}
          onUpdate={updateVolunteerActivity}
        />

        <StudyAbroadActivitySection
          activities={activityData.studyAbroadActivities}
          errors={errors.filter(e => e.startsWith('留学'))}
          onAdd={addStudyAbroadActivity}
          onRemove={removeStudyAbroadActivity}
          onUpdate={updateStudyAbroadActivity}
          onUpdatePeriod={updateStudyAbroadPeriod}
        />

        <ResearchActivitySection
          activities={activityData.researchActivities}
          errors={errors.filter(e => e.startsWith('探究'))}
          onAdd={addResearchActivity}
          onRemove={removeResearchActivity}
          onUpdate={updateResearchActivity}
        />

        <PartTimeJobActivitySection
          activities={activityData.partTimeJobActivities}
          errors={errors.filter(e => e.startsWith('アルバイト'))}
          onAdd={addPartTimeJobActivity}
          onRemove={removePartTimeJobActivity}
          onUpdate={updatePartTimeJobActivity}
          onUpdatePeriod={updatePartTimeJobPeriod}
        />

        <CertificationActivitySection
          activities={activityData.certificationActivities}
          errors={errors.filter(e => e.startsWith('資格'))}
          onAdd={addCertificationActivity}
          onRemove={removeCertificationActivity}
          onUpdate={updateCertificationActivity}
        />

        <ContestActivitySection
          activities={activityData.contestActivities}
          errors={errors.filter(e => e.startsWith('コンテスト'))}
          onAdd={addContestActivity}
          onRemove={removeContestActivity}
          onUpdate={updateContestActivity}
        />

        <ReadingActivitySection
          activities={activityData.readingActivities}
          errors={errors.filter(e => e.startsWith('読書'))}
          onAdd={addReadingActivity}
          onRemove={removeReadingActivity}
          onUpdate={updateReadingActivity}
        />

        <HobbyActivitySection
          activities={activityData.hobbyActivities}
          errors={errors.filter(e => e.startsWith('趣味'))}
          onAdd={addHobbyActivity}
          onRemove={removeHobbyActivity}
          onUpdate={updateHobbyActivity}
        />

        <OtherActivitySection
          activities={activityData.otherActivities}
          errors={errors.filter(e => e.startsWith('その他'))}
          onAdd={addOtherActivity}
          onRemove={removeOtherActivity}
          onUpdate={updateOtherActivity}
          onUpdatePeriod={updateOtherPeriod}
        />

        <ActivityFormActions onReset={handleReset} isLoading={isLoading} isSuccess={isSuccess} />

      </form>
    </div>
  );
}
