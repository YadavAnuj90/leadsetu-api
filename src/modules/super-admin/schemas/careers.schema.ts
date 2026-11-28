import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CareerJobDocument = HydratedDocument<CareerJob>;
export type CareerApplicationDocument = HydratedDocument<CareerApplication>;

export type CareerTeam =
  | 'Engineering & AI'
  | 'Product & Design'
  | 'Growth & Success'
  | 'Operations & Trust';

export type CareerJobStatus = 'open' | 'paused' | 'closed';
export type CareerApplicationStage =
  | 'new'
  | 'shortlisted'
  | 'interview'
  | 'offer'
  | 'rejected';

@Schema({ timestamps: true, collection: 'career_jobs' })
export class CareerJob {
  @Prop({ required: true, unique: true, trim: true, lowercase: true })
  slug!: string;

  @Prop({ required: true, trim: true })
  title!: string;

  @Prop({
    required: true,
    default: 'Engineering & AI',
    enum: [
      'Engineering & AI',
      'Product & Design',
      'Growth & Success',
      'Operations & Trust',
    ],
  })
  team!: CareerTeam;

  @Prop({ required: true, trim: true, default: 'Hybrid · India' })
  location!: string;

  @Prop({ required: true, trim: true, default: '2–5 Years' })
  experience!: string;

  @Prop({
    required: true,
    trim: true,
    default: 'Full-Time',
    enum: ['Full-Time', 'Contract', 'Internship'],
  })
  employmentType!: 'Full-Time' | 'Contract' | 'Internship';

  @Prop({ required: true, trim: true, default: 'Competitive + ESOPs' })
  compensation!: string;

  @Prop({ required: true, trim: true })
  summary!: string;

  @Prop({ type: [String], default: [] })
  responsibilities!: string[];

  @Prop({ type: [String], default: [] })
  skills!: string[];

  @Prop({
    required: true,
    default: 'open',
    enum: ['open', 'paused', 'closed'],
    index: true,
  })
  status!: CareerJobStatus;

  @Prop({ type: Boolean, default: false })
  featured!: boolean;

  @Prop({ type: Number, default: 0 })
  sortOrder!: number;

  @Prop({ type: Number, default: 0 })
  applicationsCount!: number;

  @Prop({ trim: true, default: '' })
  createdByName?: string;

  @Prop({ trim: true, default: '' })
  createdByEmail?: string;
}

export const CareerJobSchema = SchemaFactory.createForClass(CareerJob);
CareerJobSchema.index({ status: 1, sortOrder: 1, createdAt: -1 });

@Schema({ timestamps: true, collection: 'career_applications' })
export class CareerApplication {
  @Prop({ trim: true, default: '', index: true })
  jobId!: string;

  @Prop({ required: true, trim: true })
  jobTitle!: string;

  @Prop({ trim: true, default: 'General' })
  jobTeam!: string;

  @Prop({ required: true, trim: true })
  candidateName!: string;

  @Prop({ required: true, trim: true, lowercase: true, index: true })
  candidateEmail!: string;

  @Prop({ required: true, trim: true })
  candidatePhone!: string;

  @Prop({ trim: true, default: 'Immediate / 15 Days' })
  noticePeriod!: string;

  @Prop({ trim: true, default: '' })
  portfolioUrl!: string;

  @Prop({ trim: true, default: '' })
  coverNote!: string;

  @Prop({ required: true, trim: true })
  resumeFileName!: string;

  @Prop({ type: Number, default: 0 })
  resumeSizeBytes!: number;

  @Prop({ required: true })
  resumeBase64!: string;

  @Prop({
    required: true,
    default: 'new',
    enum: ['new', 'shortlisted', 'interview', 'offer', 'rejected'],
    index: true,
  })
  stage!: CareerApplicationStage;

  @Prop({ trim: true, default: '' })
  reviewerNotes!: string;
}

export const CareerApplicationSchema =
  SchemaFactory.createForClass(CareerApplication);
CareerApplicationSchema.index({ createdAt: -1 });
