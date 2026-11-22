/**
 * 교회에 맞게 바꾸는 설정입니다. 바꾼 뒤에는 다시 배포해야 반영됩니다.
 * (카카오 키, 관리자 설정 코드처럼 비밀인 값은 여기에 적지 않습니다. README의 '비밀 값 등록'을 보세요.)
 */
module.exports = {
  APP_NAME: '주일 예배팀 스케줄',

  // 서버가 실행될 지역 (서울)
  REGION: 'asia-northeast3',

  // 팀(카테고리). bothServices: true 이면 같은 날 1부·2부(또는 한 이벤트의 여러 시간대)를 모두 섬길 수 있습니다.
  // usePriority: true 이면 관리자가 봉사자마다 배정 우선순위(자주/보통/가끔)를 정할 수 있습니다.
  CATEGORIES: [
    { name: '방송팀', bothServices: false },
    { name: '찬양팀', bothServices: true, usePriority: true },
  ],

  // 팀 이름을 바꿨을 때 { 예전 이름: 새 이름 }. 저장된 데이터가 서버에서 자동으로 새 이름으로 옮겨집니다.
  RENAMED_CATEGORIES: { '방송실': '방송팀' },

  // 처음 시작할 때의 역할 (관리 화면에서 바꿀 수 있습니다)
  DEFAULT_ROLES: [
    { cat: '방송팀', name: '음향', count: 1 },
    { cat: '방송팀', name: '자막', count: 1 },
    { cat: '방송팀', name: '영상 송출', count: 1 },
    { cat: '찬양팀', name: '인도', count: 1 },
    { cat: '찬양팀', name: '싱어', count: 2 },
    { cat: '찬양팀', name: '건반', count: 1 },
    { cat: '찬양팀', name: '드럼', count: 1 },
  ],

  // 주일 예배 시간 (구글 캘린더 일정의 시작~끝)
  SERVICE_TIMES: {
    '1': ['11:00', '12:30'],
    '2': ['14:00', '15:30'],
  },

  // 한 번 로그인하면 이 기간 동안 로그인이 유지됩니다.
  SESSION_DAYS: 60,
};
