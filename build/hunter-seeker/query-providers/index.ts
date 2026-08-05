/*
 * The contents of this file are subject to the Common Public Attribution License Version 1.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy at
 * https://opensource.org/license/cpal-1.0. The Original Code is VoidCat Harness. The Initial Developer is
 * iamnotnotacat. Copyright (c) 2026 iamnotnotacat. All Rights Reserved. Software is provided "AS IS",
 * without warranty. See LICENSE and NOTICE for details and attribution requirements.
 */
import type { HunterSourceQueryProvider } from "../source-query.ts";
import { ENVIRONMENT_QUERY_PROVIDERS } from "./environment-query-providers.ts";
import { HUMANITARIAN_QUERY_PROVIDERS } from "./humanitarian-query-providers.ts";
import { INFRASTRUCTURE_QUERY_PROVIDERS } from "./infrastructure-query-providers.ts";
import { WEATHER_QUERY_PROVIDERS } from "./weather-query-providers.ts";
import { CREDENTIALED_QUERY_PROVIDERS } from "./credentialed-query-providers.ts";

export const HUNTER_SOURCE_QUERY_PROVIDERS: readonly HunterSourceQueryProvider[] = [
  ...HUMANITARIAN_QUERY_PROVIDERS,
  ...WEATHER_QUERY_PROVIDERS,
  ...ENVIRONMENT_QUERY_PROVIDERS,
  ...INFRASTRUCTURE_QUERY_PROVIDERS,
  ...CREDENTIALED_QUERY_PROVIDERS,
];
