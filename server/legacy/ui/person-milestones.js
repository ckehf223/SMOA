"use strict";
(function (root) {
  const fields = [
    { field: "manpikDate", stage: "만픽", label: "만픽일", header: "만픽일" },
    { field: "findADate", stage: "찾A", label: "찾A일", header: "찾A날짜" },
    { field: "habBDate", stage: "합 B", label: "합B일", header: "합B" },
    {
      field: "habADate",
      stage: "합A(육따)",
      label: "합A(육따)일",
      header: "합A\n(육따)",
      aliases: ["합A", "육따"],
    },
    { field: "youngTtaDate", stage: "영따", label: "영따일", header: "영따" },
    {
      field: "bokshinDate",
      stage: "복음방",
      label: "복신일",
      header: "복신",
      aliases: ["복신", "복A", "복B"],
    },
    {
      field: "cardReceivedDate",
      stage: "신카접수",
      label: "신카접수일",
      header: "신카접수",
      aliases: ["신가접수"],
    },
    {
      field: "centerRegisteredDate",
      stage: "센터등록",
      label: "센터등록일",
      header: "센터등록",
    },
  ];
  const normalize = (value) =>
    String(value ?? "")
      .normalize("NFC")
      .replace(/\s/g, "")
      .toLowerCase();

  function fieldForStageLabel(label) {
    const normalized = normalize(label);
    return fields.find(({ stage, aliases = [] }) =>
      [stage, ...aliases].some((name) => normalize(name) === normalized),
    );
  }

  function stageId(workspace, field) {
    const definition = fields.find((entry) => entry.field === field);
    if (!definition) return undefined;
    for (const name of [definition.stage, ...(definition.aliases || [])]) {
      const normalized = normalize(name);
      const id =
        workspace.stages.find((id) => normalize(id) === normalized) ||
        workspace.stages.find(
          (id) => normalize(workspace.stageNames[id]) === normalized,
        );
      if (id) return id;
    }
  }

  function value(person, field, workspace) {
    if (person.stageDates?.[field]) return person.stageDates[field];
    const id = stageId(workspace, field);
    if (!id) return "";
    if (field === "bokshinDate") {
      let first = "";
      for (const event of person.transitions || []) {
        if (event.to !== id || event.from === id || event.baseline) continue;
        const date = event.effectiveLocal.slice(0, 10);
        if (!first || date < first) first = date;
      }
      return first;
    }
    const event = person.transitions?.find((t) => t.to === id && t.from !== id);
    return (!event?.baseline && event?.effectiveLocal?.slice(0, 10)) || "";
  }

  const api = { fields, fieldForStageLabel, stageId, value };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PersonMilestones = api;
})(typeof window === "undefined" ? globalThis : window);
