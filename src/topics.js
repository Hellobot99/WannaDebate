import { generateTopics, mockMode } from './ai.js';

// AI에게 "무작위로 골라"라고 하면 비슷한 주제만 반복되므로,
// 분야와 키워드는 서버가 직접 뽑고 AI는 그걸로 주제만 만든다.
export const CATEGORIES = {
  일상: ['연애', '친구 관계', '음식', '여행', '돈 관리', 'SNS', '반려동물', '집안일', '패션', '잠과 휴식', '선물', '이사'],
  '학교·직장': ['시험', '조별 과제', '회식', '재택근무', '연봉', '이직', '동아리', '교복', '학원', '주 4일제', '사내 연애', '점심시간'],
  사회: ['대중교통', '환경', '복지', '공공장소 예절', '도시와 시골', '기부', '노키즈존', '팁 문화', '키오스크', '1인 가구'],
  기술: ['인공지능', '스마트폰', '게임', '자율주행', '로봇', '개인정보', '온라인 수업', '전자책', '숏폼 영상', '가상화폐'],
  문화: ['영화', '아이돌', '웹툰', '스포츠', '예능', '음악', '스포일러', '리메이크', '공연 관람', '유튜버'],
  '밸런스 게임': ['초능력', '과거와 미래', '돈과 시간', '평생 한 가지 음식', '무인도', '투명 인간', '기억', '여름과 겨울', '도시 선택', '능력 교환'],
};

const BATCH = 8; // 한 번에 AI에게 받아 오는 주제 수
const REFILL_BELOW = 6; // 풀이 이보다 줄면 미리 채운다
const RECENT_LIMIT = 80; // 최근에 쓴 주제는 다시 내지 않는다

// AI를 못 쓸 때(테스트 모드, 오류) 쓰는 기본 주제
const FALLBACK = [
  { category: '일상', title: '탕수육은 부먹이 정답이다', background: '소스를 부어 먹을지 찍어 먹을지는 오래된 논쟁입니다.', proHint: '소스가 고루 밴 맛', conHint: '바삭함 유지' },
  { category: '학교·직장', title: '재택근무가 사무실 출근보다 낫다', background: '팬데믹 이후 재택과 출근을 둘러싼 논쟁이 이어지고 있습니다.', proHint: '통근 시간 절약과 생산성', conHint: '협업과 소속감' },
  { category: '기술', title: '초등학생에게 스마트폰 사용을 금지해야 한다', background: '초등학생 스마트폰 보유율이 높아지면서 학습과 수면에 미치는 영향이 논란입니다.', proHint: '집중력과 수면 보호', conHint: '안전 연락과 디지털 역량' },
  { category: '문화', title: '영화 스포일러는 개봉 일주일 뒤면 괜찮다', background: '언제부터 결말을 말해도 되는지에 대한 기준은 사람마다 다릅니다.', proHint: '볼 사람은 이미 봤다', conHint: '관람 시점은 개인의 선택' },
  { category: '밸런스 게임', title: '과거로 가는 능력이 미래로 가는 능력보다 낫다', background: '단 한 번만 쓸 수 있는 시간 여행 능력이 주어진다면 어느 쪽을 고를까요?', proHint: '후회를 바로잡을 기회', conHint: '미리 알면 준비할 수 있다' },
  { category: '사회', title: '공공장소에서 키오스크 주문만 받는 것은 문제다', background: '키오스크가 늘면서 디지털 기기에 익숙하지 않은 사람들의 불편이 커지고 있습니다.', proHint: '디지털 약자 소외', conHint: '인건비 절감과 효율' },
  { category: '일상', title: '연인과의 데이트 비용은 반반 내야 한다', background: '데이트 비용을 어떻게 나눌지는 많은 커플의 고민입니다.', proHint: '대등한 관계', conHint: '형편에 맞는 배려' },
  { category: '학교·직장', title: '회식은 업무의 연장이다', background: '회식 참석을 업무로 볼지 개인의 선택으로 볼지 의견이 갈립니다.', proHint: '팀워크와 소통', conHint: '퇴근 후 시간은 개인의 것' },
  { category: '기술', title: 'AI가 그린 그림도 예술 작품이다', background: '생성형 AI가 만든 이미지가 공모전에서 상을 받으며 논란이 됐습니다.', proHint: '도구가 바뀌었을 뿐', conHint: '창작 의도와 노력이 없다' },
  { category: '문화', title: '아이돌 연애는 팬이 간섭할 일이 아니다', background: '아이돌의 열애설이 날 때마다 팬덤 반응이 크게 엇갈립니다.', proHint: '사생활 존중', conHint: '팬과의 약속과 이미지' },
  { category: '밸런스 게임', title: '평생 여름만 사는 게 평생 겨울만 사는 것보다 낫다', background: '한 계절로만 평생을 살아야 한다면 어느 쪽이 나을까요?', proHint: '활동하기 좋은 날씨', conHint: '더위는 피할 곳이 없다' },
  { category: '사회', title: '노키즈존은 업주의 정당한 권리다', background: '아이 동반 손님을 받지 않는 매장을 두고 차별 논란이 이어지고 있습니다.', proHint: '영업의 자유와 다른 손님의 권리', conHint: '특정 연령 전체를 배제하는 차별' },
];

const pool = [];
const recent = [];
let refilling = null;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function remember(title) {
  recent.push(title);
  if (recent.length > RECENT_LIMIT) recent.shift();
}

function randomSeeds(n) {
  // 분야가 한쪽으로 몰리지 않게 섞어서 고르고, 분야마다 키워드를 하나씩 뽑는다
  const names = Object.keys(CATEGORIES).sort(() => Math.random() - 0.5);
  return Array.from({ length: n }, (_, i) => {
    const category = names[i % names.length];
    return { category, keyword: pick(CATEGORIES[category]) };
  });
}

function fallbackTopic() {
  const fresh = FALLBACK.filter((t) => !recent.includes(t.title) && !pool.some((p) => p.title === t.title));
  return { ...pick(fresh.length ? fresh : FALLBACK) };
}

async function refill() {
  if (refilling) return refilling;
  refilling = (async () => {
    try {
      if (mockMode) {
        while (pool.length < BATCH) pool.push(fallbackTopic());
        return;
      }
      const seeds = randomSeeds(BATCH);
      const topics = await generateTopics(seeds, recent.slice(-30));
      for (const t of topics) {
        const dup = recent.includes(t.title) || pool.some((p) => p.title === t.title);
        if (!dup && t.title) pool.push(t);
      }
    } catch (err) {
      console.error('주제 생성 실패, 기본 주제로 대체:', err.message ?? err);
      while (pool.length < REFILL_BELOW) pool.push(fallbackTopic());
    } finally {
      refilling = null;
    }
  })();
  return refilling;
}

/**
 * 주제를 하나 꺼낸다. 풀이 비었으면 채울 때까지 기다리고, 꺼낸 뒤 줄었으면 미리 채워 둔다.
 * @param {string[]} avoidCategories 지금 로비에 이미 보이는 분야. 가능하면 다른 분야의 주제를 고른다.
 */
export async function takeTopic(avoidCategories = []) {
  if (!pool.length) await refill();
  const avoid = new Set(avoidCategories);
  let index = pool.findIndex((t) => !avoid.has(t.category));
  if (index < 0 && pool.length && avoid.size) {
    // 풀에 다른 분야가 없으면, 아직 로비에 없는 분야로 바로 하나 만들어 본다
    const missing = Object.keys(CATEGORIES).filter((c) => !avoid.has(c));
    if (missing.length && !mockMode) {
      try {
        const category = pick(missing);
        const [made] = await generateTopics([{ category, keyword: pick(CATEGORIES[category]) }], recent.slice(-30));
        if (made?.title && !recent.includes(made.title)) {
          remember(made.title);
          return made;
        }
      } catch {}
    }
    const fb = FALLBACK.find((t) => !avoid.has(t.category) && !recent.includes(t.title));
    if (fb) {
      remember(fb.title);
      return { ...fb };
    }
  }
  const topic = (index >= 0 ? pool.splice(index, 1)[0] : pool.shift()) ?? fallbackTopic();
  remember(topic.title);
  if (pool.length < REFILL_BELOW) refill();
  return topic;
}

/** 서버 시작 시 미리 채워 둔다 */
export function warmUp() {
  return refill();
}
