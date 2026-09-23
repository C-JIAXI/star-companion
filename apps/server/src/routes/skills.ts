import { Router } from "express";
import { asyncHandler, HttpError, parseBody } from "../lib/http.js";
import { skillDeleteSchema, skillEnableSchema, skillImportSchema, skillNameSchema, skillReferenceQuerySchema } from "../schemas.js";
import { deleteSkill, getSkill, getSkillReference, importSkill, listSkills, previewSkillImport, setSkillEnabled } from "../services/skillRegistry.js";

export const skillsRouter = Router();
const nameFor = (value: unknown) => {
  const parsed = skillNameSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Invalid Skill name");
  return parsed.data;
};

skillsRouter.get("/", asyncHandler(async (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await listSkills() });
}));

skillsRouter.post("/import", asyncHandler(async (request, response) => {
  const input = parseBody(skillImportSchema, request.body);
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await importSkill(input) });
}));

skillsRouter.post("/import-preview", asyncHandler(async (request, response) => {
  const input = parseBody(skillImportSchema, request.body);
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await previewSkillImport(input) });
}));

skillsRouter.get("/:name/reference", asyncHandler(async (request, response) => {
  const query = skillReferenceQuerySchema.safeParse(request.query);
  if (!query.success) throw new HttpError(400, "Invalid Skill reference path");
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await getSkillReference(nameFor(request.params.name), query.data.path) });
}));

skillsRouter.get("/:name", asyncHandler(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await getSkill(nameFor(request.params.name)) });
}));

skillsRouter.put("/:name/enabled", asyncHandler(async (request, response) => {
  const input = parseBody(skillEnableSchema, request.body);
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await setSkillEnabled(nameFor(request.params.name), input) });
}));

skillsRouter.delete("/:name", asyncHandler(async (request, response) => {
  const input = parseBody(skillDeleteSchema, request.body);
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await deleteSkill(nameFor(request.params.name), input.expectedVersion) });
}));
