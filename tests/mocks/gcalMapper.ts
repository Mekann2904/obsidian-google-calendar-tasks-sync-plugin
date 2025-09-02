import moment from 'moment';

export class GCalMapper {
  constructor(_app: any, _settings: any) {}
  public toEventDateTime(m: moment.Moment) {
    return { dateTime: m.format('YYYY-MM-DDTHH:mm:ss'), timeZone: 'Asia/Tokyo' };
  }
  public mapObsidianTaskToGoogleEvent(task: any) {
    return task;
  }
}


