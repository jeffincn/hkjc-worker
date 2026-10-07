export type VenueCode = "ST" | "HV" | string;

export interface GraphQLError {
  message: string;
  [key: string]: unknown;
}

export interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLError[];
}

export interface ActiveMeetingSummary {
  id?: string;
  venueCode: string;
  date: string;
  status: string;
  races?: Array<{
    no: number;
    postTime: string;
    status: string;
    wageringFieldSize?: number;
  }>;
}

export interface RunnerRaw {
  no: string | number;
  standbyNo?: string;
  status?: string;
  name_ch?: string | null;
  name_en?: string | null;
  barrierDrawNumber?: string | number | null;
  handicapWeight?: string | number | null;
  last6run?: string | null;
  finalPosition?: number | null;
  deadHeat?: boolean | null;
  winOdds?: string | number | null;
  jockey?: { name_en?: string | null; name_ch?: string | null; code?: string } | null;
  trainer?: { name_en?: string | null; name_ch?: string | null; code?: string } | null;
  horse?: { id?: string; code?: string } | null;
}

export interface RaceRaw {
  id?: string;
  no: number;
  status?: string;
  raceName_en?: string | null;
  raceName_ch?: string | null;
  postTime?: string | null;
  distance?: number | null;
  go_en?: string | null;
  go_ch?: string | null;
  raceTrack?: { description_en?: string | null; description_ch?: string | null } | null;
  raceCourse?: {
    description_en?: string | null;
    description_ch?: string | null;
    displayCode?: string | null;
  } | null;
  raceClass_en?: string | null;
  raceClass_ch?: string | null;
  runners?: RunnerRaw[];
}

export interface OddsNode {
  combString: string;
  oddsValue: string | number | null;
  hotFavourite?: boolean;
  oddsDropValue?: number;
}

export interface PmPoolRaw {
  id?: string;
  status?: string;
  sellStatus?: string;
  oddsType?: string;
  lastUpdateTime?: string | null;
  leg?: { number?: number; races?: number[] };
  oddsNodes?: OddsNode[];
  dividends?: Array<{
    winComb?: string;
    type?: string;
    div?: string | number;
    seq?: number;
    status?: string;
    partialUnit?: number;
  }>;
  rebateRate?: string | null;
}

export interface ChangeHistoryRaw {
  type?: string;
  time?: string;
  raceNo?: number;
  runnerNo?: string | number | null;
  horseName_ch?: string | null;
  horseName_en?: string | null;
  jockeyName_ch?: string | null;
  jockeyName_en?: string | null;
  scratchHorseName_ch?: string | null;
  scratchHorseName_en?: string | null;
  handicapWeight?: string | null;
  scrResvIndicator?: string | null;
}

export interface MeetingRaw {
  id?: string;
  status?: string;
  venueCode: string;
  date: string;
  totalNumberOfRace?: number;
  currentNumberOfRace?: number;
  races?: RaceRaw[];
  poolInvs?: PmPoolRaw[];
  pmPools?: PmPoolRaw[];
  changeHistories?: ChangeHistoryRaw[];
  obSt?: PmPoolRaw[];
}

export interface RaceMeetingsFullData {
  timeOffset?: { rc?: number };
  activeMeetings?: ActiveMeetingSummary[];
  raceMeetings?: MeetingRaw[];
}

export interface PmPoolsOddsData {
  raceMeetings?: Array<{ pmPools?: PmPoolRaw[] }>;
}

export interface RacingChangesData {
  raceMeetings?: Array<{
    id?: string;
    venueCode?: string;
    date?: string;
    changeHistories?: ChangeHistoryRaw[];
  }>;
}

export interface ResultMeetingsData {
  raceMeetings?: Array<{
    id?: string;
    resPools?: PmPoolRaw[];
  }>;
}

export interface RbcListData {
  raceMeetings?: Array<{ date: string; venueCode: string }>;
}

export interface RbcMeetingData {
  raceMeetings?: MeetingRaw[];
}
