// 셸이 이름을 달고 실패하는 방법. 코드 없는 오류는 UI 에게 "무엇이 없어서 안 됐는가"를
// 말해 주지 못하고, 그 순간 실패는 전부 같은 실패로 뭉개진다.

/** 이 셸에 대응 개념이 없다. 창·웹뷰·네이티브 표면의 거절은 전부 이 이름이다. */
const ABSENT_CODE = "FRAMEWORK_CONCEPT_ABSENT";

function frameworkError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

module.exports = { ABSENT_CODE, frameworkError };
